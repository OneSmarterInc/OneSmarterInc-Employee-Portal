import { sql,json,body,requireManager,sendEmail,emailDetails,audit } from '../server/core.js'

const ok=(res,data={})=>json(res,200,data)
const bad=(res,message,status=400)=>json(res,status,{error:message})
const method=req=>(req.method||'GET').toUpperCase()
function parts(req){const raw=req.query?.route;if(Array.isArray(raw))return raw.flatMap(v=>String(v).split('/')).filter(Boolean);if(typeof raw==='string')return raw.split('/').filter(Boolean);return []}
const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]))
async function employee(id){const rows=await sql`SELECT e.id,e.employee_code,e.wfh_allowed,u.email,u.full_name FROM employees e JOIN users u ON u.id=e.user_id WHERE e.id=${id} LIMIT 1`;return rows[0]||null}

export default async function handler(req,res){
 const p=parts(req),m=method(req)
 try{
  const manager=await requireManager(req,res);if(!manager)return
  if(m!=='POST')return bad(res,'Method not allowed',405)
  const data=await body(req)
  if(p[0]==='document'){
   const emp=await employee(data.employee_id);if(!emp)return bad(res,'Employee not found',404)
   const title=String(data.title||'New employee document'),type=String(data.document_type||'OTHER').replaceAll('_',' ')
   const html=`<p>Hello ${esc(emp.full_name)},</p><p>A new HR document has been added to your OneSmarter employee portal.</p>${emailDetails([['Document',esc(title)],['Type',esc(type)],['Employee ID',esc(emp.employee_code)]])}<p><a href="https://one-smarter-inc-employee-portal.vercel.app/documents" style="display:inline-block;background:#e31b23;color:#fff;text-decoration:none;padding:10px 16px;border-radius:7px;font-weight:700">Open My Letters</a></p>`
   const result=await sendEmail({to:emp.email,subject:`New employee document · ${title}`,html});await audit(manager.id,'DOCUMENT_EMAIL_SENT','employee',emp.id,{title,type});return ok(res,{sent:!result.skipped,result})
  }
  if(p[0]==='wfh'){
   const emp=await employee(data.employee_id);if(!emp)return bad(res,'Employee not found',404)
   const allowed=Boolean(data.allowed),html=`<p>Hello ${esc(emp.full_name)},</p><p>Your Work From Home entitlement has been <b>${allowed?'enabled':'disabled'}</b> by a manager.</p>${emailDetails([['Employee ID',esc(emp.employee_code)],['WFH access',allowed?'Enabled':'Disabled']])}<p>${allowed?'You can now select Work From Home when checking in.':'The Work From Home option will no longer be available during check-in.'}</p>`
   const result=await sendEmail({to:emp.email,subject:`WFH access ${allowed?'enabled':'updated'}`,html});await audit(manager.id,'WFH_EMAIL_SENT','employee',emp.id,{allowed});return ok(res,{sent:!result.skipped,result})
  }
  if(p[0]==='password-reset'){
   const emp=await employee(data.employee_id);if(!emp)return bad(res,'Employee not found',404)
   const password=String(data.password||'');if(!password)return bad(res,'Temporary password is required')
   const html=`<p>Hello ${esc(emp.full_name)},</p><p>Your OneSmarter employee portal password has been reset by a manager.</p>${emailDetails([['Portal','<a href="https://one-smarter-inc-employee-portal.vercel.app">Employee Portal</a>'],['Login email',esc(emp.email)],['Temporary password',esc(password)]])}<p>Please sign in and change the password from Account.</p>`
   const result=await sendEmail({to:emp.email,subject:'Your OneSmarter portal password was reset',html});await audit(manager.id,'PASSWORD_RESET_EMAIL_SENT','employee',emp.id);return ok(res,{sent:!result.skipped,result})
  }
  if(p[0]==='policy'){
   const title=String(data.title||'Company policy'),category=String(data.category||'HR'),version=String(data.version||'1.0'),required=Boolean(data.required_ack)
   const employees=await sql`SELECT u.email,u.full_name,e.employee_code FROM employees e JOIN users u ON u.id=e.user_id WHERE e.status<>'INACTIVE' AND u.active=TRUE ORDER BY u.full_name`
   let sent=0,failed=0
   for(const emp of employees){try{const html=`<p>Hello ${esc(emp.full_name)},</p><p>A company policy has been published in your OneSmarter employee portal.</p>${emailDetails([['Policy',esc(title)],['Category',esc(category)],['Version',esc(version)],['Acknowledgement',required?'Required':'Not required']])}<p><a href="https://one-smarter-inc-employee-portal.vercel.app/policies" style="display:inline-block;background:#e31b23;color:#fff;text-decoration:none;padding:10px 16px;border-radius:7px;font-weight:700">Open Policies</a></p>`;const result=await sendEmail({to:emp.email,subject:`Company policy · ${title}`,html});if(result.skipped)failed++;else sent++}catch{failed++}}
   await audit(manager.id,'POLICY_EMAIL_BROADCAST','policy',data.policy_id||null,{title,sent,failed});return ok(res,{sent,failed})
  }
  return bad(res,'Not found',404)
 }catch(error){console.error(error);return bad(res,error?.message||'Email notification failed',500)}
}
