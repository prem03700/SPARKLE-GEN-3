/** In-memory audit log prototype. Replace with durable, access-controlled storage later. */
export function createAuditService({clock=()=>new Date().toISOString()}={}) {
  const events=[];
  return Object.freeze({
    record({type,actor="system",subject=null,decision="recorded",details={}}={}) {
      if(!type || typeof type!=="string") throw new TypeError("Audit event type is required.");
      const event=Object.freeze({id:`audit-${events.length+1}`,at:clock(),type,actor,subject,decision,details:structuredClone(details)});
      events.push(event); return event;
    },
    list({type,limit=100}={}) { return events.filter(e=>!type||e.type===type).slice(-Math.max(0,limit)).map(e=>structuredClone(e)); },
    count(){return events.length;}
  });
}
