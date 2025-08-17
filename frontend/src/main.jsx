import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const API = import.meta.env.VITE_API || 'http://localhost:8787/api';

function FrontPage({ onNext, state, setState }) {
  const [form, setForm] = useState(state.customer || { name:'', phone:'', address:'', email:'' });
  useEffect(()=>{ setState(s => ({...s, customer: form})); }, [form]);
  const area = inferArea(form.address);
  return (
    <div className="card">
      <h2>Book your detail</h2>
      <div className="row">
        <input placeholder="Full name" value={form.name} onChange={e=>setForm({...form, name:e.target.value})} />
        <input placeholder="Phone" value={form.phone} onChange={e=>setForm({...form, phone:e.target.value})} />
      </div>
      <input placeholder="Address" value={form.address} onChange={e=>setForm({...form, address:e.target.value})} />
      <input placeholder="Email (for confirmations)" value={form.email} onChange={e=>setForm({...form, email:e.target.value})} />
      <div className="badge">Service area: <b>{area.toUpperCase()}</b></div>
      <button onClick={onNext} disabled={!form.name || !form.phone || !form.address}>Next</button>
    </div>
  );
}

function ServicesPage({ onNext, onBack, state, setState, config }) {
  const [service, setService] = useState(state.service_key || 'exterior');
  const [addons, setAddons] = useState(state.addons || []);
  useEffect(()=> setState(s => ({...s, service_key: service, addons })), [service, addons]);
  const toggle = k => setAddons(a => a.includes(k) ? a.filter(x=>x!==k) : [...a, k]);
  return (
    <div className="card">
      <h2>Select service</h2>
      <select value={service} onChange={e=>setService(e.target.value)}>
        {Object.entries(config.services || {
          exterior: {name:'Exterior Detail'},
          full: {name:'Full Detail'},
          standard_membership: {name:'Standard Membership'},
          premium_membership: {name:'Premium Membership'}
        }).map(([k,v]) => (
          <option key={k} value={k}>{v.name}</option>
        ))}
      </select>
      <h3>Add-ons</h3>
      {Object.entries(config.addons || { wax:{name:'Full Body Wax'}, polish:{name:'Hand Polish'} }).map(([k,v]) => (
        <label key={k} style={{display:'block'}}>
          <input type="checkbox" checked={addons.includes(k)} onChange={()=>toggle(k)} />
          {v.name}
        </label>
      ))}
      <div className="row">
        <button onClick={onBack}>Back</button>
        <button onClick={onNext}>See availability</button>
      </div>
    </div>
  );
}

function CalendarPage({ onNext, onBack, state, setState }) {
  const [slots, setSlots] = useState([]);
  const [selected, setSelected] = useState(state.slot || null);
  const isMembership = state.service_key?.includes('membership');
  const [selected2, setSelected2] = useState(state.membershipSlots || []);

  useEffect(() => {
    fetch(API+'/config').then(r=>r.json()).then(cfg => { window._cfg = cfg; });
    const body = {
      service_key: state.service_key,
      addons: state.addons,
      area: inferArea(state.customer.address),
    };
    fetch(API+'/availability', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})
      .then(r=>r.json())
      .then(d => setSlots(d.slots || []));
  }, []);

  function choose(slot) {
    if (isMembership) {
      setSelected2(curr => {
        const exists = curr.find(s => s.start_iso === slot.start_iso);
        if (exists) return curr.filter(s => s.start_iso !== slot.start_iso);
        if (curr.length >= 2) return [curr[1], slot];
        return [...curr, slot];
      });
    } else {
      setSelected(slot);
    }
  }

  function next() {
    if (isMembership) setState(s => ({...s, membershipSlots: selected2}));
    else setState(s => ({...s, slot: selected}));
    onNext();
  }

  return (
    <div className="card">
      <h2>Choose time</h2>
      <div>
        {slots.slice(0, 140).map(s => {
          const label = new Date(s.start_iso).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
          const sel = isMembership ? !!selected2.find(x=>x.start_iso===s.start_iso) : (selected?.start_iso===s.start_iso);
          return <span key={s.start_iso} className={"slot " + (sel ? "selected": "")} onClick={()=>choose(s)}>{label}</span>
        })}
      </div>
      <div className="row">
        <button onClick={onBack}>Back</button>
        <button onClick={next} disabled={isMembership ? selected2.length!==2 : !selected}>Review</button>
      </div>
    </div>
  );
}

function ConfirmPage({ onBack, state, setState }) {
  const isMembership = state.service_key?.includes('membership');
  const total = computeTotal(state.service_key, state.addons);
  async function confirm() {
    const payload = {
      customer: state.customer,
      area: inferArea(state.customer.address),
      service_key: state.service_key,
      addons: state.addons,
      slot: state.slot,
      membershipSlots: state.membershipSlots
    };
    const res = await fetch(API+'/book', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
      .then(r=>r.json());
    if (res.ok) {
      alert('Booking successful! Check your email for confirmation.');
      setState({});
      location.reload();
    } else {
      alert('Error: ' + (res.error || 'Unknown'));
    }
  }
  return (
    <div className="card">
      <h2>Confirm</h2>
      <p><b>Name:</b> {state.customer?.name}</p>
      <p><b>Phone:</b> {state.customer?.phone}</p>
      <p><b>Address:</b> {state.customer?.address}</p>
      <p><b>Service:</b> {state.service_key}</p>
      <p><b>Add-ons:</b> {(state.addons||[]).join(', ') || 'None'}</p>
      <p><b>When:</b> {isMembership ? state.membershipSlots?.map(s => new Date(s.start_iso).toLocaleString()).join(' & ') : new Date(state.slot?.start_iso).toLocaleString()}</p>
      <p><b>Total:</b> £{total.toFixed(2)}</p>
      <div className="row">
        <button onClick={onBack}>Back</button>
        <button onClick={confirm}>Pay & Book</button>
      </div>
    </div>
  );
}

function AdminPage() {
  const [rows, setRows] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [tips, setTips] = useState(0);
  useEffect(()=>{ load(); loadReviews(); },[]);
  function load(){ fetch(API+'/admin/bookings').then(r=>r.json()).then(d => setRows(d.bookings || [])); }
  function loadReviews(){ fetch(API+'/admin/reviews').then(r=>r.json()).then(d => { setReviews(d.reviews||[]); setTips(d.total_tips_gbp||0); }); }
  function badge(status){ return <span className="badge">{status}</span>; }
  return (
    <div className="card">
      <h2>Admin — Bookings</h2>
      <table className="admin-table">
        <thead><tr><th>Start</th><th>End</th><th>Service</th><th>Client</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{new Date(r.start_iso).toLocaleString()}</td>
              <td>{new Date(r.end_iso).toLocaleTimeString()}</td>
              <td>{r.service_key}</td>
              <td>{r.name} — {r.phone}</td>
              <td>{badge(r.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{marginTop:24}}>Latest Reviews & Tips</h3>
      <p><b>Total tips recorded:</b> £{Number(tips).toFixed(2)}</p>
      <table className="admin-table">
        <thead><tr><th>When</th><th>Client</th><th>Rating</th><th>Comments</th><th>Tip</th></tr></thead>
        <tbody>
          {reviews.slice(0,20).map(r => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.name} — {r.phone}</td>
              <td>{r.rating}</td>
              <td>{r.comments}</td>
              <td>£{(r.tip_amount_pence/100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Feedback & Thank you pages */
function useQuery(){
  const u = new URL(location.href);
  const params = Object.fromEntries(u.searchParams.entries());
  return params;
}

function FeedbackPage(){
  const q = useQuery();
  const [info, setInfo] = useState(null);
  const [rating, setRating] = useState(5);
  const [comments, setComments] = useState('');
  const [tip, setTip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(()=>{
    const url = API + '/feedback/info?booking_id=' + encodeURIComponent(q.booking_id||'') + '&token=' + encodeURIComponent(q.token||'');
    fetch(url).then(r=>r.json()).then(d=>{
      if(d.ok) setInfo(d.booking); else setError(d.error||'Not found');
    }).catch(()=>setError('Network error')).finally(()=>setLoading(false));
  }, []);

  async function submit(){
    setLoading(true);
    const payload = {
      booking_id: Number(q.booking_id),
      token: q.token,
      rating: Number(rating),
      comments,
      tip_gbp: Number(tip),
      success_url: location.origin + '/thank-you?tip=' + (Number(tip)>0?1:0),
      cancel_url: location.origin + '/feedback?booking_id=' + q.booking_id + '&token=' + q.token
    };
    const res = await fetch(API+'/feedback/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json());
    setLoading(false);
    if(res.redirect_url){
      location.href = res.redirect_url;
    } else if(res.ok){
      location.href = '/thank-you';
    } else {
      alert(res.error || 'Something went wrong');
    }
  }

  if(loading) return <div className="card"><p>Loading…</p></div>;
  if(error) return <div className="card"><p>{error}</p></div>;
  return (
    <div className="card">
      <h2>How did we do?</h2>
      <p>Service: <b>{info.service_key}</b> on {new Date(info.start_iso).toLocaleString()}</p>
      <label>Rating (1–5)
        <input type="number" min="1" max="5" value={rating} onChange={e=>setRating(e.target.value)} />
      </label>
      <label>Comments (optional)
        <textarea style={{width:'100%', minHeight:120}} value={comments} onChange={e=>setComments(e.target.value)} />
      </label>
      <h3>Leave a tip (optional)</h3>
      <div className="row">
        {[0,5,10,20].map(v => (
          <button key={v} onClick={()=>setTip(v)} className={tip==v?'selected':''}>£{v}</button>
        ))}
      </div>
      <label>Custom tip (£)
        <input type="number" min="0" step="1" value={tip} onChange={e=>setTip(e.target.value)} />
      </label>
      <button onClick={submit}>Submit</button>
    </div>
  )
}

function ThankYouPage(){
  const q = useQuery();
  return (
    <div className="card">
      <h2>Thank you!</h2>
      <p>Your feedback has been recorded{q.tip? ' and your tip has been received (pending Stripe confirmation).':'.'}</p>
      <a href="/">Back to booking page</a>
    </div>
  );
}

function App() {
  const [state, setState] = useState({});
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({ services:{}, addons:{} });
  useEffect(() => { fetch(API+'/config').then(r=>r.json()).then(setConfig); }, []);
  const pages = [
    <FrontPage onNext={()=>setStep(1)} state={state} setState={setState} />,
    <ServicesPage onNext={()=>setStep(2)} onBack={()=>setStep(0)} state={state} setState={setState} config={config} />,
    <CalendarPage onNext={()=>setStep(3)} onBack={()=>setStep(1)} state={state} setState={setState} />,
    <ConfirmPage onBack={()=>setStep(2)} state={state} setState={setState} />,
    <AdminPage />,
  ];
  return (
    <div className="container">
      <h1>GM Auto Detailing</h1>
      <div style={{display:'flex', gap:8, marginBottom: 8}}>
        <button onClick={()=>setStep(0)}>Book</button>
        <button onClick={()=>setStep(4)}>Admin</button>
      </div>
      {pages[step]}
    </div>
  );
}

function Router(){
  const path = location.pathname;
  if (path.startsWith('/feedback')) return <FeedbackPage/>;
  if (path.startsWith('/thank-you')) return <ThankYouPage/>;
  return <App/>;
}

function inferArea(address){
  const s = (address||'').toLowerCase();
  if (s.includes('west')) return 'left';
  if (s.includes('east')) return 'right';
  return 'right';
}
function computeTotal(service, addons){
  const map = { exterior:60, full:120, standard_membership:100, premium_membership:220 };
  const addonsMap = { wax:15, polish:15 };
  let t = map[service] || 0;
  if (!service?.includes?.('membership')) {
    t += (addons||[]).reduce((s,k)=> s + (addonsMap[k]||0), 0);
  }
  return t;
}

createRoot(document.getElementById('root')).render(<Router />);
