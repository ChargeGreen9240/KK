export function validateSchedule(p,now=Date.now()){
 if(!p||typeof p.id!=='string'||!Number.isFinite(p.energy)||p.energy<=0||p.energy>200||!Array.isArray(p.periods)||p.periods.length<1||p.periods.length>192)throw Error('Invalid schedule');
 let prev=0;for(const s of p.periods){if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.end<=s.start||s.start<prev||s.end>now+48*3600000||s.start<now-60000)throw Error('Invalid schedule period');prev=s.end}return p;
}
export function scheduleDecision(plan,now,delivered=0){if(!plan)return 'idle';if(delivered>=plan.energy-.01||now>=plan.periods.at(-1).end)return 'complete';return plan.periods.some(p=>p.start<=now&&now<p.end)?'charge':'pause'}
