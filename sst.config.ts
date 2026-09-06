/// <reference path="./.sst/platform/config.d.ts" />
 
 export default $config({
  app(input) {
    const tags = {
      Project: "claim-status",
      Environment: input.stage,
    };

    return {
      name: "claim-status",
      home: "aws",
      removal: input.stage === "production" ? "retain" : "remove",
      providers: {
        aws: {
          profile: "claim-status",
          region: process.env.AWS_REGION || "us-east-1",
          defaultTags: {
            tags,
          },
        },
      },
    };
  },
  async run() {
    const aws = await import("@pulumi/aws");
    const fs = await import("node:fs");

    function loadDeployEnv() {
      const values: Record<string, string> = {};
      for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, "utf8");
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const separator = line.indexOf("=");
          if (separator <= 0) continue;
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
          values[key] = value;
        }
      }
      return values;
    }

    const deployEnv = loadDeployEnv();
    const databaseUrl = process.env.DATABASE_URL || deployEnv.DATABASE_URL || "";
    const dbSsl = process.env.DB_SSL || deployEnv.DB_SSL || "true";
    const workerImageUriOverride = process.env.WORKER_IMAGE_URI || deployEnv.WORKER_IMAGE_URI || "";
    const skipFrontendBuild = (process.env.SST_SKIP_FRONTEND_BUILD || deployEnv.SST_SKIP_FRONTEND_BUILD || "").toLowerCase() === "true";
    if (!databaseUrl) {
      throw new Error("DATABASE_URL must be set in the shell or .env.local before deploying AWS workflow APIs.");
    }

    const inputsBucket = new sst.aws.Bucket("WorkflowInputs", {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["PUT", "GET", "HEAD"],
        allowHeaders: ["*"],
      },
    });

    const outputsBucket = new sst.aws.Bucket("WorkflowOutputs", {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "HEAD"],
        allowHeaders: ["*"],
      },
    });

    const userPool = new aws.cognito.UserPool("InternalUsers", {
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      passwordPolicy: {
        minimumLength: 12,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: false,
        requireUppercase: true,
        temporaryPasswordValidityDays: 7,
      },
      mfaConfiguration: "OPTIONAL",
      softwareTokenMfaConfiguration: {
        enabled: true,
      },
    });

    const userPoolClient = new aws.cognito.UserPoolClient("WebClient", {
      userPoolId: userPool.id,
      generateSecret: false,
      explicitAuthFlows: [
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
      ],
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ["code", "implicit"],
      allowedOauthScopes: ["email", "openid", "profile"],
      callbackUrls: [
        "http://localhost:3000/",
        "https://d2rdco8saesh4t.cloudfront.net/",
      ],
      logoutUrls: [
        "http://localhost:3000/",
        "https://d2rdco8saesh4t.cloudfront.net/",
      ],
      supportedIdentityProviders: ["COGNITO"],
    });

    const userPoolDomain = new aws.cognito.UserPoolDomain("InternalUsersDomain", {
      userPoolId: userPool.id,
      domain: $interpolate`claim-status-${$app.stage}-${aws.getCallerIdentityOutput({}).accountId}`,
    });

    const vpc = new sst.aws.Vpc("Vpc", {
      nat: undefined,
    });

    const cluster = new sst.aws.Cluster("Cluster", {
      vpc,
    });

    const workerRepository = new aws.ecr.Repository("WorkerRepository", {
      name: `claim-status-${$app.stage}-worker`,
      imageTagMutability: "MUTABLE",
      forceDelete: $app.stage !== "production",
    });

    const workerImageUri = workerImageUriOverride || $interpolate`${workerRepository.repositoryUrl}:dev`;

    const webSocketApi = new sst.aws.ApiGatewayWebSocket("WorkflowWebSocketApi", {
      transform: {
        route: {
          handler: (args) => {
            args.environment ??= {};
            args.environment.DATABASE_URL = databaseUrl;
            args.environment.DB_SSL = dbSsl;
            args.environment.COGNITO_ISSUER = $interpolate`https://cognito-idp.${aws.getRegionOutput({}).name}.amazonaws.com/${userPool.id}`;
            args.environment.COGNITO_CLIENT_ID = userPoolClient.id;
          },
        },
      },
    });

    const workerTask = new sst.aws.Task("WorkerTask", {
      cluster,
      cpu: "2 vCPU",
      memory: "4 GB",
      storage: "50 GB",
      public: true,
      containers: [
        {
          name: "worker",
          image: workerImageUri,
          environment: {
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            DATABASE_URL: databaseUrl,
            DB_SSL: dbSsl,
            BROWSER_HEADLESS: "true",
            OPTUM_PRO_CUSTOM_USER_AGENT: "true",
            BROWSER_KEEP_OPEN: "false",
            EXIT_AFTER_WORKFLOW_DONE: "true",
            EXIT_AFTER_WORKFLOW_DELAY_MS: "15000",
            WORKFLOW_INPUTS_BUCKET: inputsBucket.name,
            WORKFLOW_OUTPUTS_BUCKET: outputsBucket.name,
            WEBSOCKET_MANAGEMENT_ENDPOINT: webSocketApi.managementEndpoint,
          },
          logging: {
            name: $interpolate`/claim-status/${$app.stage}/worker`,
            retention: "1 week",
          },
        },
      ],
      permissions: [
        {
          actions: ["s3:ListBucket"],
          resources: [inputsBucket.arn, outputsBucket.arn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [
            $interpolate`${inputsBucket.arn}/*`,
            $interpolate`${outputsBucket.arn}/*`,
          ],
        },
        {
          actions: ["execute-api:ManageConnections"],
          resources: ["*"],
        },
      ],
    });

    const httpApi = new sst.aws.ApiGatewayV2("WorkflowHttpApi", {
      cors: {
        allowOrigins: ["*"],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      },
      transform: {
        route: {
          handler: (args) => {
            args.environment ??= {};
            args.environment.DATABASE_URL = databaseUrl;
            args.environment.DB_SSL = dbSsl;
            args.environment.WORKFLOW_INPUTS_BUCKET = inputsBucket.name;
            args.environment.WORKFLOW_OUTPUTS_BUCKET = outputsBucket.name;
            args.environment.WORKER_CLUSTER_ARN = cluster.id;
            args.environment.WORKER_TASK_DEFINITION_ARN = workerTask.nodes.taskDefinition.arn;
            args.environment.WORKER_CONTAINER_NAME = "worker";
            args.environment.WORKER_LOG_GROUP = $interpolate`/claim-status/${$app.stage}/worker`;
            args.environment.WORKER_SUBNET_IDS = $jsonStringify(workerTask.subnets);
            args.environment.WORKER_SECURITY_GROUP_IDS = $jsonStringify(workerTask.securityGroups);
            args.permissions ??= [];
            args.permissions.push(
              {
                actions: ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:TagResource"],
                resources: ["*"],
              },
              {
                actions: ["iam:PassRole"],
                resources: ["*"],
              },
              {
                actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                resources: [
                  $interpolate`${inputsBucket.arn}/*`,
                  $interpolate`${outputsBucket.arn}/*`,
                ],
              },
              {
                actions: ["s3:ListBucket"],
                resources: [inputsBucket.arn, outputsBucket.arn],
              },
              {
                actions: ["logs:FilterLogEvents"],
                resources: [$interpolate`arn:aws:logs:${aws.getRegionOutput({}).name}:${aws.getCallerIdentityOutput({}).accountId}:log-group:/claim-status/${$app.stage}/worker:*`],
              },
            );
          },
        },
      },
    });

    const httpAuthorizer = httpApi.addAuthorizer({
      name: "Cognito",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${aws.getRegionOutput({}).name}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClient.id],
      },
    });
    const httpAuth = { jwt: { authorizer: httpAuthorizer.id } };

    httpApi.route("POST /jobs", "backend/src/aws/http/create-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs", "backend/src/aws/http/list-jobs.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/confirm", "backend/src/aws/http/confirm-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs/{jobId}", "backend/src/aws/http/get-job.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/otp", "backend/src/aws/http/submit-otp.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/cancel", "backend/src/aws/http/cancel-job.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/force-stop", "backend/src/aws/http/force-stop-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs/{jobId}/download", "backend/src/aws/http/download-job.handler", { auth: httpAuth });

    webSocketApi.route("$connect", "backend/src/aws/ws/connect.handler");
    webSocketApi.route("$disconnect", "backend/src/aws/ws/disconnect.handler");
    webSocketApi.route("$default", "backend/src/aws/ws/default.handler");

    const frontend = new sst.aws.StaticSite("Frontend", {
      path: ".",
      environment: {
        STATIC_EXPORT: "true",
        NEXT_PUBLIC_WORKFLOW_API_URL: "/api",
        NEXT_PUBLIC_WORKFLOW_WS_URL: webSocketApi.url,
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: userPool.id,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: userPoolClient.id,
        NEXT_PUBLIC_COGNITO_DOMAIN: $interpolate`https://${userPoolDomain.domain}.auth.${aws.getRegionOutput({}).name}.amazoncognito.com`,
      },
      build: {
        command: skipFrontendBuild ? "npm run build:static:verify" : "npm run build:static",
        output: "out",
      },
    });

    return {
      frontendUrl: frontend.url,
      httpApiUrl: httpApi.url,
      webSocketApiUrl: webSocketApi.url,
      cognitoUserPoolId: userPool.id,
      cognitoClientId: userPoolClient.id,
      cognitoDomain: $interpolate`https://${userPoolDomain.domain}.auth.${aws.getRegionOutput({}).name}.amazoncognito.com`,
      inputBucketName: inputsBucket.name,
      outputBucketName: outputsBucket.name,
      workerRepositoryUrl: workerRepository.repositoryUrl,
      workerImageUri,
      cluster: cluster.id,
      workerTaskDefinition: workerTask.nodes.taskDefinition.arn,
      workerTaskLogGroup: $interpolate`/claim-status/${$app.stage}/worker`,
    };
  },
});
