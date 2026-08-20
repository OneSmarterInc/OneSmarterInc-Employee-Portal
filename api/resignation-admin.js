import { sql,json,body,requireManager,notify,audit,sendEmail,emailDetails } from '../server/core.js'

const ok=(res,data={})=>json(res,200,data),bad=(res,message,status=400)=>json(res,status,{error:message}),method=req=>(req.method||'GET').toUpperCase()
function parts(req){const raw=req.query?.route;if(Array.isArray(raw))return raw.flatMap(v=>String(v).split('/')).filter(Boolean);if(typeof raw==='string')return raw.split('/').filter(Boolean);return []}
const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]))

export default async function handler(req,res){
 const p=parts(req),m=method(req)
 try{
  const manager=await requireManager(req,res);if(!manager)return
  if(p[0]&&p[1]==='review'&&m==='PATCH'){
   const data=await body(req),status=data.status==='APPROVED'?'APPROVED':data.status==='REJECTED'?'REJECTED':null;if(!status)return bad(res,'Status must be APPROVED or REJECTED')
   const r=(await sql`SELECT r.*,e.user_id,e.employee_code,u.email,u.full_name FROM resignations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id WHERE r.id=${p[0]} AND r.status='PENDING' LIMIT 1`)[0];if(!r)return bad(res,'Pending resignation not found',404)
   const approvedLastDay=status==='APPROVED'?(data.approved_last_day||r.requested_last_day):null
   await sql`UPDATE resignations SET status=${status},approved_last_day=${approvedLastDay},manager_comment=${data.comment||null},reviewed_by=${manager.id},reviewed_at=NOW() WHERE id=${r.id}`
   await sql`UPDATE employees SET status=${status==='APPROVED'?'NOTICE':'ACTIVE'},updated_at=NOW() WHERE id=${r.employee_id}`
   await notify(r.user_id,`Resignation ${status.toLowerCase()}`,data.comment||'', '/resignation')
   const html=`<p>Hello ${esc(r.full_name)},</p><p>Your resignation request has been <b>${status.toLowerCase()}</b>.</p>${emailDetails([['Employee ID',esc(r.employee_code)],['Requested last day',r.requested_last_day?esc(String(r.requested_last_day).slice(0,10)):'—'],['Approved last day',approvedLastDay?esc(String(approvedLastDay).slice(0,10)):'—'],['Manager note',esc(data.comment||'—')],['Clearance status',status==='APPROVED'?'Not started':'Not applicable']])}`
   try{await sendEmail({to:r.email,subject:`Resignation ${status.toLowerCase()}`,html})}catch{}
   await audit(manager.id,`RESIGNATION_${status}`,'resignation',r.id,{employee_id:r.employee_id,approved_last_day:approvedLastDay,comment:data.comment||''});return ok(res,{status,approved_last_day:approvedLastDay})
  }
  if(p[0]&&p[1]==='clearance'&&m==='PATCH'){
   const data=await body(req),clearance=['NOT_STARTED','IN_PROGRESS','CLEARED'].includes(data.clearance_status)?data.clearance_status:null;if(!clearance)return bad(res,'Invalid clearance status')
   const r=(await sql`SELECT r.*,e.user_id,e.employee_code,u.email,u.full_name FROM resignations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id WHERE r.id=${p[0]} LIMIT 1`)[0];if(!r)return bad(res,'Resignation not found',404)
   await sql`UPDATE resignations SET clearance_status=${clearance},status=CASE WHEN ${clearance}='CLEARED' THEN 'COMPLETED' ELSE status END WHERE id=${p[0]}`
   if(clearance==='CLEARED'){await sql`UPDATE employees SET status='INACTIVE',updated_at=NOW() WHERE id=${r.employee_id}`;await sql`UPDATE users SET active=FALSE,updated_at=NOW() WHERE id=${r.user_id}`}
   await notify(r.user_id,'Resignation clearance updated',`Clearance status: ${clearance.replaceAll('_',' ')}`,'/resignation')
   try{await sendEmail({to:r.email,subject:'Resignation clearance update',html:`<p>Hello ${esc(r.full_name)},</p><p>Your resignation clearance status has been updated.</p>${emailDetails([['Employee ID',esc(r.employee_code)],['Clearance',esc(clearance.replaceAll('_',' '))],['Employment status',clearance==='CLEARED'?'Completed':'Notice period']])}`})}catch{}
   await audit(manager.id,'RESIGNATION_CLEARANCE_UPDATED','resignation',p[0],{employee_id:r.employee_id,clearance});return ok(res,{clearance_status:clearance,status:clearance==='CLEARED'?'COMPLETED':r.status})
  }
  return bad(res,'Not found',404)
 }catch(error){console.error(error);return bad(res,error?.message||'Resignation update failed',500)}
}
