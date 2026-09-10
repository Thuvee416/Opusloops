import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export class ApiError extends Error {
  constructor(status,code,message) { super(message); this.status=status; this.code=code; }
}
export const uuid = value => {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400,'invalid_request','Identifier is invalid');
  return value.toLowerCase();
};
export const textField = (value,max=255) => {
  if (typeof value!=='string' || !value.length || value.length>max) throw new ApiError(400,'invalid_request','A required field is invalid');
  return value;
};
export const numberField = (value,min,max,integer=false) => {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min || value>max || (integer&&!Number.isSafeInteger(value))) throw new ApiError(400,'invalid_request','A numeric field is invalid');
  return value;
};
export const objectField = value => {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new ApiError(400,'invalid_request','An object is required');
  return value;
};
export const lambda = new LambdaClient({});
export async function db(event) {
  const request={...event,...(event.identity?{identity:{id:event.identity.id}}:{})};
  const response = await lambda.send(new InvokeCommand({FunctionName:process.env.DATABASE_FUNCTION || 'opusloops-aws-database',Payload:Buffer.from(JSON.stringify(request))}));
  if (response.FunctionError) throw new ApiError(503,'service_unavailable','Database service is temporarily unavailable');
  const result = JSON.parse(Buffer.from(response.Payload).toString());
  if (!result.ok) {
    const mapping = {P0002:[404,'not_found'],40001:[409,'stale_revision'],55000:[409,'invalid_state'],54000:[409,'processing_capacity_busy'],42501:[403,'forbidden'],22023:[400,'invalid_request'],23505:[409,'conflict']};
    const [status,code] = mapping[result.code] || [503,'service_unavailable'];
    throw new ApiError(status,code,result.message || 'Database operation is unavailable');
  }
  return result.value;
}
export const rpc = (name,parameters,identity) => db({operation:'rpc',name,parameters,identity});
let callbackMaster;
export async function workerSecret() {
  if (!callbackMaster) {
    const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:process.env.CALLBACK_SECRET_ARN}));
    if (!result.SecretString || result.SecretString.length<32) throw new ApiError(503,'service_unavailable','Worker callback is not configured');
    callbackMaster = result.SecretString;
  }
  return callbackMaster;
}
export const bucketMap = () => ({
  'opusloops-stem-uploads': process.env.UPLOADS_BUCKET,
  'opusloops-stem-sources': process.env.SOURCES_BUCKET,
  'opusloops-stem-artifacts': process.env.ARTIFACTS_BUCKET,
});
export function physicalBucket(logical) {
  const result = bucketMap()[logical];
  if (!result) throw new ApiError(400,'invalid_bucket','Storage bucket is invalid');
  return result;
}
