import { useState, useEffect } from 'react'

const KIND_LABEL = { recurring: 'Recurring', one_time: 'One-time', per_use: 'Per use' }

function NewExpenseModal({ onClose, onSave }) {
  const [kind, setKind] = useState('recurring')
  const [provider, setProvider] = useState('')
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [billingPeriod, setBillingPeriod] = useState('monthly')
  const [notes, setNotes] = useState('')

  function submit() {
    if (!provider.trim() || !label.trim() || !amount) return
    onSave({
      kind,
      provider: provider.trim(),
      label: label.trim(),
      amount_usd: parseFloat(amount),
      billing_period: kind === 'recurring' ? billingPeriod : null,
      notes: notes.trim() || null,
    })
  }

  const fieldStyle = { width: '100%', padding: '10px 14px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg)', fontSize: 14, color: 'var(--text-primary)' }
  const labelStyle = { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--surface)', borderRadius: 20,
        padding: 32, width: 380, boxShadow: 'var(--shadow-lg)',
      }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.4px', marginBottom: 20 }}>New Expense</h2>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={labelStyle}>Type</div>
          <select value={kind} onChange={e => setKind(e.target.value)} style={fieldStyle}>
            <option value="recurring">Recurring subscription</option>
            <option value="one_time">One-time purchase</option>
            <option value="per_use">Per-use (e.g. one generation)</option>
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={labelStyle}>Provider</div>
          <input value={provider} onChange={e => setProvider(e.target.value)} placeholder="e.g. Higgsfield" style={fieldStyle} />
        </label>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={labelStyle}>Label</div>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Creator plan" style={fieldStyle} />
        </label>

        <label style={{ display: 'block', marginBottom: 14 }}>
          <div style={labelStyle}>Amount (USD)</div>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={fieldStyle} />
        </label>

        {kind === 'recurring' && (
          <label style={{ display: 'block', marginBottom: 14 }}>
            <div style={labelStyle}>Billing period</div>
            <select value={billingPeriod} onChange={e => setBillingPeriod(e.target.value)} style={fieldStyle}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
        )}

        <label style={{ display: 'block', marginBottom: 24 }}>
          <div style={labelStyle}>Notes (optional)</div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything worth remembering" style={fieldStyle} />
        </label>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>Cancel</button>
          <button onClick={submit} style={{ flex: 1, padding: '10px 0', borderRadius: 10, background: 'linear-gradient(135deg,#EC4899,#8B5CF6)', color: '#fff', fontSize: 14, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

export default function Expenses() {
  const [expenses, setExpenses] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [error, setError] = useState(null)

  function load() {
    fetch('/api/db/expenses')
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setExpenses(d.expenses) })
      .catch(e => setError(e.message))
  }

  useEffect(load, [])

  async function addExpense(payload) {
    const r = await fetch('/api/db/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const d = await r.json()
    if (d.error) { setError(d.error); return }
    setShowNew(false)
    load()
  }

  async function deleteExpense(id) {
    if (!window.confirm('Delete this expense?')) return
    await fetch(`/api/db/expenses?id=${id}`, { method: 'DELETE' })
    load()
  }

  const monthlyTotal = (expenses || [])
    .filter(e => e.kind === 'recurring')
    .reduce((sum, e) => sum + Number(e.amount_usd) / (e.billing_period === 'yearly' ? 12 : 1), 0)

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '120px 24px 60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.6px' }}>Expenses</h1>
        <button
          onClick={() => setShowNew(true)}
          style={{ padding: '10px 18px', borderRadius: 980, background: 'linear-gradient(135deg,#EC4899,#8B5CF6)', color: '#fff', fontSize: 14, fontWeight: 700 }}
        >+ Add expense</button>
      </div>

      <div style={{
        background: 'var(--surface)', borderRadius: 16, padding: 24, marginBottom: 32,
        border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
          Monthly recurring total
        </div>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-1px' }}>${monthlyTotal.toFixed(2)}</div>
      </div>

      {error && <div style={{ color: '#FF3B30', marginBottom: 20 }}>{error}</div>}

      {expenses === null && !error && <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>}

      {expenses && expenses.length === 0 && (
        <div style={{ color: 'var(--text-secondary)' }}>No expenses logged yet.</div>
      )}

      {expenses && expenses.map(e => (
        <div key={e.id} style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '14px 18px', borderRadius: 12,
          background: 'var(--surface)', border: '1px solid var(--border)', marginBottom: 8,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 980,
            background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', flexShrink: 0,
          }}>{KIND_LABEL[e.kind]}</div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{e.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {e.provider}{e.notes ? ` — ${e.notes}` : ''}
            </div>
          </div>

          <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap' }}>
            ${Number(e.amount_usd).toFixed(2)}{e.billing_period ? ` / ${e.billing_period === 'monthly' ? 'mo' : 'yr'}` : ''}
          </div>

          <button
            onClick={() => deleteExpense(e.id)}
            style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(255,59,48,0.1)', color: '#FF3B30', fontSize: 15, flexShrink: 0 }}
          >×</button>
        </div>
      ))}

      {showNew && <NewExpenseModal onClose={() => setShowNew(false)} onSave={addExpense} />}
    </div>
  )
}
