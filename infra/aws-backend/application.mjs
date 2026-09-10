const ref = Ref => ({ Ref });
const attr = (id, key) => ({ 'Fn::GetAtt': [id, key] });
const policy = Statement => ({ Version: '2012-10-17', Statement });
const tags = [{ Key: 'Application', Value: 'Opusloops' }];
const stages = ['inspect', 'analyze', 'propose', 'render'];
const title = value => value[0].toUpperCase() + value.slice(1);

export function applicationTemplate({ outputs, account, region, codeKey, image, executionRole, taskRole }) {
  if (account !== '368310207026' || region !== 'us-east-1' || !new RegExp(`^${account}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/opusloops/stem-worker@sha256:[a-f0-9]{64}$`).test(image)) throw new Error('Unexpected AWS application target');
  const queue = `arn:aws:batch:${region}:${account}:job-queue/opusloops-stem-worker`;
  const buckets = [outputs.UploadsBucket, outputs.SourcesBucket, outputs.ArtifactsBucket];
  const objects = buckets.map(bucket => `arn:aws:s3:::${bucket}/*`);
  const roleArn = `arn:aws:iam::${account}:role/opusloops-aws-api`;
  const workerArn = `arn:aws:iam::${account}:role/opusloops-aws-storage`;
  const apiUrl = attr('HttpApi', 'ApiEndpoint');
  const resources = {
    HttpApi: { Type: 'AWS::ApiGatewayV2::Api', Properties: { Name: 'opusloops-aws', ProtocolType: 'HTTP', DisableExecuteApiEndpoint: false } },
    ApiLogs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: '/aws/lambda/opusloops-aws-api', RetentionInDays: 14 } },
    ApiRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'opusloops-aws-api', Tags: tags,
      AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      Policies: [{ PolicyName: 'ApplicationServices', PolicyDocument: policy([
        { Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: `arn:aws:lambda:${region}:${account}:function:opusloops-aws-database` },
        { Effect: 'Allow', Action: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminSetUserPassword'], Resource: `arn:aws:cognito-idp:${region}:${account}:userpool/${outputs.UserPoolId}` },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts', 's3:DeleteObject', 's3:DeleteObjectVersion'], Resource: objects },
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:ListBucketVersions'], Resource: buckets.map(bucket => `arn:aws:s3:::${bucket}`) },
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: outputs.CallbackSecretArn },
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: workerArn },
        { Effect: 'Allow', Action: 'batch:SubmitJob', Resource: [queue, ...stages.map(stage => ref(`${title(stage)}Definition`))] },
        { Effect: 'Allow', Action: ['batch:ListJobs', 'batch:DescribeJobs'], Resource: '*' },
        { Effect: 'Allow', Action: 'batch:TerminateJob', Resource: `arn:aws:batch:${region}:${account}:job/*` },
      ]) }],
    } },
    StorageRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'opusloops-aws-storage', MaxSessionDuration: 3600, Tags: tags,
      AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'sts:AssumeRole', Condition: { ArnEquals: { 'aws:PrincipalArn': roleArn } } }]),
      Policies: [{ PolicyName: 'ScopedAgainByEveryJobSession', PolicyDocument: policy([{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: objects }]) }],
    } },
    ApiFunction: { Type: 'AWS::Lambda::Function', DependsOn: ['ApiLogs', 'StorageRole'], Properties: {
      FunctionName: 'opusloops-aws-api', Description: 'Cognito-verified Opusloops application API; database access uses private IAM bridge',
      Runtime: 'nodejs22.x', Architectures: ['arm64'], Handler: 'api.handler', Role: attr('ApiRole', 'Arn'),
      Code: { S3Bucket: outputs.MigrationBucket, S3Key: codeKey }, MemorySize: 512, Timeout: 60, Tags: tags,
      Environment: { Variables: { API_URL: apiUrl, AWS_ACCOUNT_ID: account, DATABASE_FUNCTION: 'opusloops-aws-database',
        USER_POOL_ID: outputs.UserPoolId, USER_POOL_CLIENT_ID: outputs.UserPoolClientId, CALLBACK_SECRET_ARN: outputs.CallbackSecretArn,
        UPLOADS_BUCKET: outputs.UploadsBucket, SOURCES_BUCKET: outputs.SourcesBucket, ARTIFACTS_BUCKET: outputs.ArtifactsBucket,
        WORKER_STORAGE_ROLE: workerArn, BATCH_JOB_QUEUE: queue,
        ...Object.fromEntries(stages.map(stage => [`BATCH_${stage.toUpperCase()}_DEFINITION`, ref(`${title(stage)}Definition`)])),
      } },
    } },
    Integration: { Type: 'AWS::ApiGatewayV2::Integration', Properties: { ApiId: ref('HttpApi'), IntegrationType: 'AWS_PROXY', IntegrationUri: attr('ApiFunction', 'Arn'), PayloadFormatVersion: '2.0', TimeoutInMillis: 30000 } },
    Route: { Type: 'AWS::ApiGatewayV2::Route', Properties: { ApiId: ref('HttpApi'), RouteKey: '$default', Target: { 'Fn::Join': ['/', ['integrations', ref('Integration')]] } } },
    Stage: { Type: 'AWS::ApiGatewayV2::Stage', Properties: { ApiId: ref('HttpApi'), StageName: '$default', AutoDeploy: true, DefaultRouteSettings: { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 10 } } },
    ApiPermission: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('ApiFunction'), Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceArn: { 'Fn::Sub': `arn:aws:execute-api:${region}:${account}:\${HttpApi}/*` } } },
  };
  for (const stage of stages) resources[`${title(stage)}Definition`] = { Type: 'AWS::Batch::JobDefinition', Properties: {
    JobDefinitionName: `opusloops-aws-stem-${stage}`, Type: 'container', PlatformCapabilities: ['FARGATE'], RetryStrategy: { Attempts: 1 }, Timeout: { AttemptDurationSeconds: 1800 },
    EcsProperties: { TaskProperties: [{ ExecutionRoleArn: executionRole, TaskRoleArn: taskRole, PlatformVersion: '1.4.0',
      NetworkConfiguration: { AssignPublicIp: 'ENABLED' }, RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' }, EphemeralStorage: { SizeInGiB: 50 },
      Containers: [{ Name: 'worker', Image: image, Command: [stage, '--payload-base64', 'Ref::payload_base64'], Essential: true, User: '10001:10001', Privileged: false, ReadonlyRootFilesystem: false,
        LinuxParameters: { InitProcessEnabled: true }, ResourceRequirements: [{ Type: 'VCPU', Value: '4' }, { Type: 'MEMORY', Value: '16384' }],
        Environment: [{ Name: 'OPUSLOOPS_AWS_STORAGE_ACCOUNT', Value: account }, { Name: 'OPUSLOOPS_AWS_CALLBACK_URL', Value: { 'Fn::Join': ['', [apiUrl, '/worker/callback']] } }],
        LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': '/aws/batch/opusloops-stem-worker', 'awslogs-region': region, 'awslogs-stream-prefix': `aws-${stage}` } },
      }],
    }] }, Tags: { Application: 'Opusloops', Provider: 'AWS' },
  } };
  const rules = {
    StorageEvents: { EventPattern: { source: ['aws.s3'], 'detail-type': ['Object Created'], detail: { bucket: { name: buckets } } } },
    BatchFailures: { EventPattern: { source: ['aws.batch'], 'detail-type': ['Batch Job State Change'], detail: { status: ['FAILED'], jobQueue: [queue], jobDefinition: stages.map(stage => ref(`${title(stage)}Definition`)) } } },
    Retention: { ScheduleExpression: 'rate(5 minutes)', input: { source: 'aws.events', action: 'retention' } },
    Watchdog: { ScheduleExpression: 'rate(2 minutes)', input: { source: 'aws.events', action: 'watchdog' } },
  };
  for (const [id, { input, ...properties }] of Object.entries(rules)) {
    resources[`${id}Rule`] = { Type: 'AWS::Events::Rule', Properties: { ...properties, State: 'ENABLED', Targets: [{ Id: 'Application', Arn: attr('ApiFunction', 'Arn'), ...(input ? { Input: JSON.stringify(input) } : {}), RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 5 } }] } };
    resources[`${id}Permission`] = { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: ref('ApiFunction'), Action: 'lambda:InvokeFunction', Principal: 'events.amazonaws.com', SourceArn: attr(`${id}Rule`, 'Arn') } };
  }
  return { AWSTemplateFormatVersion: '2010-09-09', Description: 'Native AWS Opusloops API, identity, file storage and isolated audio processing', Resources: resources,
    Outputs: { ApiUrl: { Value: apiUrl }, WorkerImage: { Value: image } } };
}
