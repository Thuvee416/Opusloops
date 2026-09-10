import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import { createHash } from 'node:crypto';
import { ApiError,db,rpc,textField } from './common.mjs';

export const client = new cognito.CognitoIdentityProviderClient({});
const send = (command,body) => client.send(new cognito[command](body));
const attributes = user => Object.fromEntries((user.UserAttributes || user.Attributes || []).map(({Name,Value})=>[Name,Value]));
export function accessClaims(token, {region=process.env.AWS_REGION,pool=process.env.USER_POOL_ID,clientId=process.env.USER_POOL_CLIENT_ID}={}) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
    if (claims.iss!==`https://cognito-idp.${region}.amazonaws.com/${pool}` || claims.client_id!==clientId
        || claims.token_use!=='access' || !Number.isInteger(claims.exp) || claims.exp<=Date.now()/1000) throw new Error();
    return claims;
  } catch { throw new ApiError(401,'invalid_token','Sign in again'); }
}
export async function authenticate(token) {
  textField(token,8192);
  const claims = accessClaims(token);
  // Cognito validates the signature, revocation, and disabled state before any
  // decoded claim is trusted. A token from another pool/client is rejected too.
  const remote = await send('GetUserCommand',{AccessToken:token});
  const attrs = attributes(remote);
  if (attrs.sub!==claims.sub) throw new ApiError(401,'invalid_token','Sign in again');
  const identity = await db({operation:'identity',subject:attrs.sub});
  return {id:identity.id,subject:attrs.sub,username:remote.Username,token,claims,attrs,identity};
}
function publicUser(user,pendingEmail='') {
  return {id:user.id,email:user.attrs.email||user.identity.email,new_email:pendingEmail,
    created_at:user.identity.created_at,user_metadata:{display_name:user.attrs.name || user.identity.raw_user_meta_data?.display_name || ''}};
}
export async function tokenSession(body,grant) {
  const refresh = grant==='refresh_token';
  if (!refresh && grant!=='password') throw new ApiError(400,'invalid_request','Unsupported sign-in request');
  const response = await send('InitiateAuthCommand',{
    ClientId:process.env.USER_POOL_CLIENT_ID,AuthFlow:refresh?'REFRESH_TOKEN_AUTH':'USER_PASSWORD_AUTH',
    AuthParameters:refresh?{REFRESH_TOKEN:textField(body.refresh_token,8192)}:{USERNAME:textField(body.email,254).trim().toLowerCase(),PASSWORD:textField(body.password,256)},
  });
  if (!response.AuthenticationResult) throw new ApiError(409,'authentication_challenge','This account requires an additional sign-in step');
  const result = response.AuthenticationResult;
  const user = await authenticate(result.AccessToken);
  return {access_token:result.AccessToken,refresh_token:result.RefreshToken || body.refresh_token,token_type:'bearer',
    expires_in:result.ExpiresIn,expires_at:Math.floor(Date.now()/1000)+result.ExpiresIn,user:publicUser(user)};
}
export async function getUser(user) {
  // Preserve the immutable ID while reflecting Cognito-confirmed profile values.
  await db({operation:'profile',identity:user,email:user.attrs.email,displayName:user.attrs.name || user.identity.raw_user_meta_data?.display_name || ''});
  return publicUser(user);
}
export async function updateUser(user,body) {
  if (body.email || body.password) {
    if (!Number.isInteger(user.claims.auth_time) || Date.now()/1000-user.claims.auth_time>300) throw new ApiError(401,'reauthentication_required','Confirm your current password');
  }
  const updates = [];
  if (body.data?.display_name!==undefined) updates.push({Name:'name',Value:textField(body.data.display_name,40).trim()});
  if (body.email) updates.push({Name:'email',Value:textField(body.email,254).trim().toLowerCase()});
  if (body.password) {
    const password = textField(body.password,256);
    if (password.length<8) throw new ApiError(400,'weak_password','Use at least 8 characters');
    await send('AdminSetUserPasswordCommand',{UserPoolId:process.env.USER_POOL_ID,Username:user.username,Password:password,Permanent:true});
  }
  if (updates.length) await send('UpdateUserAttributesCommand',{AccessToken:user.token,UserAttributes:updates});
  const fresh = await authenticate(user.token);
  await getUser(fresh);
  return publicUser(fresh,body.email && body.email.toLowerCase()!==fresh.attrs.email ? body.email.toLowerCase() : '');
}
export async function verifyEmail(user,body) {
  const code = textField(body.code,8);
  if (!/^\d{6,8}$/.test(code)) throw new ApiError(400,'invalid_request','Enter the email verification code');
  await send('VerifyUserAttributeCommand',{AccessToken:user.token,AttributeName:'email',Code:code});
  return getUser(await authenticate(user.token));
}
export async function signOut(user,body) {
  if (body.refresh_token) await send('RevokeTokenCommand',{ClientId:process.env.USER_POOL_CLIENT_ID,Token:textField(body.refresh_token,8192)});
  else await send('GlobalSignOutCommand',{AccessToken:user.token});
  return null;
}
export async function createAccount(body) {
  const email = textField(body.email,254).trim().toLowerCase();
  const password = textField(body.password,256);
  const invite = textField(body.inviteCode,256).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8) throw new ApiError(400,'invalid_request','Enter a valid email and password');
  const reservation = await rpc('reserve_opusloops_signup_invite',{p_email:email,p_token_hash:createHash('sha256').update(invite).digest('hex')});
  if (!reservation?.userId) throw new ApiError(403,'invalid_invitation','Invitation is invalid or expired');
  const Username=reservation.userId,UserPoolId=process.env.USER_POOL_ID;
  try {
    await send('AdminCreateUserCommand',{UserPoolId,Username,MessageAction:'SUPPRESS',UserAttributes:[
      {Name:'email',Value:email},{Name:'email_verified',Value:'true'},{Name:'custom:opusloops_id',Value:Username},
    ]});
  } catch(error) { if(error.name!=='UsernameExistsException') throw error; }
  const created = await send('AdminGetUserCommand',{UserPoolId,Username});
  const attrs = attributes(created);
  if (attrs.email?.toLowerCase()!==email || attrs['custom:opusloops_id']!==Username) throw new ApiError(409,'account_exists','Account already exists');
  if (created.UserStatus==='FORCE_CHANGE_PASSWORD') await send('AdminSetUserPasswordCommand',{UserPoolId,Username,Password:password,Permanent:true});
  await db({operation:'bind-identity',id:Username,subject:attrs.sub,email});
  if (await rpc('complete_opusloops_signup_invite',{p_invite_id:reservation.inviteId,p_user_id:Username})!==true) throw new ApiError(503,'signup_unavailable','Account setup could not be completed');
  return {created:true};
}
