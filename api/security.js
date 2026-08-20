import crypto from 'node:crypto'
import { sql,json,body,issueSession,clearSession,currentUser,comparePassword,hashPassword,sendEmail,audit,ensureSecuritySchema } from '../server/core.js'

const ok=(res,data={})=>json(res,200,data),bad=(res,message,status=400)=>json(res,status,{error:message}),method=req=>(req.method||'GET').toUpperCase()
function parts(req){const raw=req.query?.route;if(Array.isArray(raw))return raw.flatMap(v=>String(v).split('/')).filter(Boolean);if(typeof raw==='string')return raw.split('/').filter(Boolean);return(req.url||'').split('?')[0].replace(/^\/api\/security\/?/,'').split('/').filter(Boolean)}
const ip=req=>String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'').split(',')[0].trim()
const codeHash=code=>crypto.createHash('sha256').update(String(code)).digest('hex')
async function summary(user){return{id:user.id,email:user.email,name:user.full_name,role:user.role,access_role:user.access_role||(user.role==='MANAGER'?'SUPER_ADMIN':'EMPLOYEE'),must_change_password:Boolean(user.must_change_password),two_factor_enabled:Boolean(user.two_factor_enabled)}}

export default async function handler(req,res){
 const p=parts(req),m=method(req)
 try{
  await ensureSecuritySchema()
  if(p[0]==='login'&&m==='POST'){
   const d=await body(req),email=String(d.email||'').trim().toLowerCase(),remote=ip(req)
   if(!email||!d.password)return bad(res,'Email and password are required')
   const recent=await sql`SELECT COUNT(*)::int AS count FROM login_events le LEFT JOIN users u ON u.id=le.user_id WHERE le.event_type='FAILED_LOGIN' AND le.created_at>NOW()-INTERVAL '15 minutes' AND (le.ip_address=${remote} OR u.email=${email})`
   if(Number(recent[0]?.count||0)>=8)return bad(res,'Too many failed sign-in attempts. Try again in 15 minutes.',429)
   const rows=await sql`SELECT * FROM users WHERE email=${email} LIMIT 1`,user=rows[0]
   if(!user||!user.active||!(await comparePassword(String(d.password),user.password_hash))){if(user)await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${user.id},'FAILED_LOGIN',${remote},${req.headers['user-agent']||''})`;return bad(res,'Invalid email or password',401)}
   const access=user.access_role||(user.role==='MANAGER'?'SUPER_ADMIN':'EMPLOYEE')
   if(user.two_factor_enabled&&access!=='EMPLOYEE'){
    const code=String(crypto.randomInt(100000,999999)),challenge=crypto.randomUUID(),target=(user.two_factor_email||user.email).trim().toLowerCase()
    await sql`DELETE FROM login_challenges WHERE user_id=${user.id} AND used_at IS NULL`
    await sql`INSERT INTO login_challenges(id,user_id,code_hash,expires_at) VALUES (${challenge},${user.id},${codeHash(code)},NOW()+INTERVAL '10 minutes')`
    const delivery=await sendEmail({to:target,subject:'Your OneSmarter sign-in code',html:`<p>Your verification code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:5px">${code}</p><p>This code expires in 10 minutes. If you did not try to sign in, contact your administrator.</p>`})
    if(delivery?.skipped)return bad(res,'Two-factor authentication is enabled but SMTP is not configured',503)
    return ok(res,{requires_2fa:true,challenge_id:challenge,email_hint:target.replace(/^(.{2}).*(@.*)$/,'$1***$2')})
   }
   await issueSession(res,user);await sql`UPDATE users SET last_login_at=NOW() WHERE id=${user.id}`;await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${user.id},'LOGIN',${remote},${req.headers['user-agent']||''})`;return ok(res,{user:await summary(user)})
  }
  if(p[0]==='verify-2fa'&&m==='POST'){
   const d=await body(req);if(!d.challenge_id||!d.code)return bad(res,'Verification code is required')
   const rows=await sql`SELECT c.*,u.* FROM login_challenges c JOIN users u ON u.id=c.user_id WHERE c.id=${d.challenge_id} AND c.used_at IS NULL AND c.expires_at>NOW() LIMIT 1`,row=rows[0]
   if(!row||row.code_hash!==codeHash(d.code))return bad(res,'Invalid or expired verification code',401)
   await sql`UPDATE login_challenges SET used_at=NOW() WHERE id=${d.challenge_id}`;await issueSession(res,row);await sql`UPDATE users SET last_login_at=NOW() WHERE id=${row.user_id}`;await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${row.user_id},'LOGIN',${ip(req)},${req.headers['user-agent']||''})`;return ok(res,{user:await summary({...row,id:row.user_id})})
  }
  const user=await currentUser(req);if(!user)return bad(res,'Please sign in',401)
  if(p[0]==='me'&&m==='GET')return ok(res,{user:await summary(user)})
  if(p[0]==='change-password'&&m==='POST'){
   const d=await body(req);if(!d.current_password||!d.new_password||String(d.new_password).length<10)return bad(res,'Use a new password with at least 10 characters')
   const row=(await sql`SELECT password_hash FROM users WHERE id=${user.id} LIMIT 1`)[0];if(!row||!(await comparePassword(String(d.current_password),row.password_hash)))return bad(res,'Current password is incorrect',401)
   const hash=await hashPassword(String(d.new_password));const updated=(await sql`UPDATE users SET password_hash=${hash},must_change_password=FALSE,session_version=session_version+1,updated_at=NOW() WHERE id=${user.id} RETURNING *`)[0];await audit(user.id,'PASSWORD_CHANGED','user',user.id);await issueSession(res,updated);return ok(res,{changed:true,user:await summary(updated)})
  }
  if(p[0]==='sessions'&&p[1]==='revoke'&&m==='POST'){await sql`UPDATE users SET session_version=session_version+1,updated_at=NOW() WHERE id=${user.id}`;await audit(user.id,'ALL_SESSIONS_REVOKED','user',user.id);clearSession(res);return ok(res,{revoked:true})}
  if(p[0]==='2fa'&&m==='GET')return ok(res,{enabled:Boolean(user.two_factor_enabled),email:user.two_factor_email||user.email,available:user.access_role!=='EMPLOYEE'||user.role==='MANAGER'})
  if(p[0]==='2fa'&&m==='PUT'){
   const access=user.access_role||(user.role==='MANAGER'?'SUPER_ADMIN':'EMPLOYEE');if(access==='EMPLOYEE')return bad(res,'Two-factor settings are managed for staff accounts only',403);const d=await body(req),enabled=Boolean(d.enabled),email=String(d.email||user.email).trim().toLowerCase();await sql`UPDATE users SET two_factor_enabled=${enabled},two_factor_email=${email},session_version=session_version+1,updated_at=NOW() WHERE id=${user.id}`;await audit(user.id,enabled?'TWO_FACTOR_ENABLED':'TWO_FACTOR_DISABLED','user',user.id,{email});clearSession(res);return ok(res,{enabled,email,reauthenticate:true})
  }
  return bad(res,'Not found',404)
 }catch(error){console.error(error);return bad(res,error?.message||'Unexpected server error',500)}
}
