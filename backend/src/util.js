export function addMinutes(date, mins){ return new Date(new Date(date).getTime()+mins*60000); }
export function clampToWorkingWindow(date, dayCfg){
  const d = new Date(date);
  const [sh,sm] = dayCfg.start.split(':').map(Number);
  const [eh,em] = dayCfg.end.split(':').map(Number);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm, 0, 0);
  const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em, 0, 0);
  return { start, end };
}
