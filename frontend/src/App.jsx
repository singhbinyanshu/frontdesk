import React, { useState, useEffect } from 'react';
import './App.css';

const API_BASE = ''; // Relative path leverages Vite dev proxy to backend

export default function App() {
  const [agents, setAgents] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [myTickets, setMyTickets] = useState([]);
  const [unassignedTickets, setUnassignedTickets] = useState([]);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [activeTicketData, setActiveTicketData] = useState(null); // { ticket, messages }
  const [activeTab, setActiveTab] = useState('my-tickets'); // 'my-tickets' | 'unassigned'

  // Form states
  const [publicReplyBody, setPublicReplyBody] = useState('');
  const [internalNoteBody, setInternalNoteBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);

  // New ticket modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [newSeverity, setNewSeverity] = useState('medium');

  // Load agents on startup
  useEffect(() => {
    fetch(`${API_BASE}/api/agents`)
      .then(res => res.json())
      .then(data => {
        setAgents(data);
        if (data.length > 0) {
          setSelectedAgentId(data[0].id);
        }
      })
      .catch(err => console.error('Failed to load agents:', err));
  }, []);

  // Fetch ticket lists whenever selected agent changes
  useEffect(() => {
    if (!selectedAgentId) return;
    loadTickets();
  }, [selectedAgentId]);

  // Fetch ticket details whenever selected ticket changes
  useEffect(() => {
    if (!selectedTicketId) {
      setActiveTicketData(null);
      return;
    }
    loadTicketDetails(selectedTicketId);
  }, [selectedTicketId]);

  const loadTickets = async () => {
    try {
      // 1. My assigned tickets sorted by closest deadline first (Rule U1, U2)
      if (selectedAgentId) {
        const myRes = await fetch(`${API_BASE}/api/tickets?owner_agent_id=${selectedAgentId}`);
        const myData = await myRes.json();
        setMyTickets(Array.isArray(myData) ? myData : []);
      } else {
        setMyTickets([]);
      }

      // 2. Unassigned queue (Rule U4)
      const unassignedRes = await fetch(`${API_BASE}/api/tickets?unassigned=true`);
      const unassignedData = await unassignedRes.json();
      setUnassignedTickets(Array.isArray(unassignedData) ? unassignedData : []);
    } catch (err) {
      console.error('Error loading tickets:', err);
    }
  };

  const loadTicketDetails = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${id}`);
      if (res.ok) {
        const data = await res.json();
        setActiveTicketData(data);
      }
    } catch (err) {
      console.error('Error fetching ticket details:', err);
    }
  };

  // Helper to format remaining working time
  const formatTimeRemaining = (ticket) => {
    if (ticket.status === 'waiting_customer') {
      return 'Paused (Waiting on customer)';
    }
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      return `Status: ${ticket.status}`;
    }

    // Measure against first response deadline if not yet responded, else resolution deadline
    const deadlineStr = !ticket.first_response_at ? ticket.first_response_deadline : ticket.resolution_deadline;
    if (!deadlineStr) return '';

    const now = new Date();
    const deadline = new Date(deadlineStr);
    const diffMins = Math.round((deadline - now) / 60000);

    if (diffMins < 0) {
      const overdue = Math.abs(diffMins);
      const hours = Math.floor(overdue / 60);
      const mins = overdue % 60;
      return `Overdue by ${hours > 0 ? `${hours}h ` : ''}${mins}m`;
    }

    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours > 0 ? `${hours}h ` : ''}${mins}m remaining`;
  };

  // Claim Ticket (Rule C2)
  const handleClaim = async (ticketId) => {
    setIsSubmitting(true);
    setActionMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedAgentId })
      });

      if (res.status === 409) {
        const err = await res.json();
        alert(err.error || 'Ticket has already been taken by another agent!');
        loadTickets();
        return;
      }

      if (res.ok) {
        const claimed = await res.json();
        setActionMessage('Ticket successfully claimed!');
        await loadTickets();
        setSelectedTicketId(claimed.id);
        setActiveTab('my-tickets');
      }
    } catch (err) {
      console.error('Claim failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Release Ticket (Rule C4)
  const handleRelease = async (ticketId) => {
    if (!confirm('Release this ticket back to the unassigned queue?')) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedAgentId })
      });

      if (res.ok) {
        setActionMessage('Ticket released back to unassigned queue');
        await loadTickets();
        setSelectedTicketId(null);
      }
    } catch (err) {
      console.error('Release failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Post Public Reply (Rule C3, S4)
  const handleSendPublicReply = async (e) => {
    e.preventDefault();
    if (!publicReplyBody.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${selectedTicketId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: selectedAgentId,
          visibility: 'public',
          body: publicReplyBody
        })
      });

      if (res.status === 403) {
        const data = await res.json();
        alert(data.error);
        return;
      }

      if (res.ok) {
        setPublicReplyBody('');
        await loadTicketDetails(selectedTicketId);
        await loadTickets();
      }
    } catch (err) {
      console.error('Error posting public reply:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Post Team-Only Internal Note (Rule U3, N1)
  const handleSendInternalNote = async (e) => {
    e.preventDefault();
    if (!internalNoteBody.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${selectedTicketId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: selectedAgentId,
          visibility: 'internal',
          body: internalNoteBody
        })
      });

      if (res.ok) {
        setInternalNoteBody('');
        await loadTicketDetails(selectedTicketId);
      }
    } catch (err) {
      console.error('Error posting internal note:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Status Change Helper (Rule L1, W1)
  const handleStatusChange = async (newStatus) => {
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${selectedTicketId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          agent_id: selectedAgentId
        })
      });

      if (res.ok) {
        await loadTicketDetails(selectedTicketId);
        await loadTickets();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update status');
      }
    } catch (err) {
      console.error('Status change error:', err);
    }
  };

  // Create Ticket Form submission
  const handleCreateTicket = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle,
          description: newDesc,
          customer_name: newCustomerName,
          customer_email: newCustomerEmail,
          severity: newSeverity
        })
      });

      if (res.ok) {
        const ticket = await res.json();
        setShowNewModal(false);
        setNewTitle('');
        setNewDesc('');
        setNewCustomerName('');
        setNewCustomerEmail('');
        await loadTickets();
        setSelectedTicketId(ticket.id);
        setActiveTab('unassigned');
      }
    } catch (err) {
      console.error('Failed to create ticket:', err);
    }
  };

  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  const currentTicket = activeTicketData?.ticket;
  const isOwner = currentTicket?.owner_agent_id === selectedAgentId;

  return (
    <div className="frontdesk-app">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand">
          <span className="logo-badge">FD</span>
          <h1>Frontdesk Support</h1>
        </div>

        <div className="header-actions">
          <button className="btn btn-secondary" onClick={() => setShowNewModal(true)}>
            + New Ticket
          </button>

          <div className="agent-picker">
            <label htmlFor="agent-select">Active Agent:</label>
            <select
              id="agent-select"
              value={selectedAgentId || ''}
              onChange={e => setSelectedAgentId(parseInt(e.target.value, 10))}
            >
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.email})
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <div className="app-body">
        {/* Left Column: Ticket Queues */}
        <aside className="queue-sidebar">
          <div className="queue-tabs">
            <button
              className={`tab-btn ${activeTab === 'my-tickets' ? 'active' : ''}`}
              onClick={() => setActiveTab('my-tickets')}
            >
              My Tickets ({myTickets.length})
            </button>
            <button
              className={`tab-btn ${activeTab === 'unassigned' ? 'active' : ''}`}
              onClick={() => setActiveTab('unassigned')}
            >
              Unassigned Queue ({unassignedTickets.length})
            </button>
          </div>

          <div className="ticket-list">
            {activeTab === 'my-tickets' && (
              <>
                {myTickets.length === 0 ? (
                  <div className="empty-queue">No tickets currently assigned to you.</div>
                ) : (
                  myTickets.map(ticket => (
                    <div
                      key={ticket.id}
                      className={`ticket-card ${selectedTicketId === ticket.id ? 'selected' : ''}`}
                      onClick={() => setSelectedTicketId(ticket.id)}
                    >
                      <div className="card-top">
                        <span className="ticket-code">{ticket.ticket_code}</span>
                        <div className="badges-group">
                          <span className={`badge severity-${ticket.severity}`}>
                            {ticket.severity}
                          </span>
                          {ticket.badge === 'Late' && (
                            <span className="badge badge-late">Late</span>
                          )}
                          {ticket.badge === 'Waiting' && (
                            <span className="badge badge-waiting">Waiting</span>
                          )}
                        </div>
                      </div>

                      <h4 className="card-title">{ticket.title}</h4>
                      <div className="card-meta">
                        <span>{ticket.customer_name}</span>
                        <span className={`time-remaining ${ticket.badge === 'Late' ? 'text-late' : ''}`}>
                          ⏱ {formatTimeRemaining(ticket)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {activeTab === 'unassigned' && (
              <>
                {unassignedTickets.length === 0 ? (
                  <div className="empty-queue">Unassigned queue is empty. Good job!</div>
                ) : (
                  unassignedTickets.map(ticket => (
                    <div
                      key={ticket.id}
                      className={`ticket-card ${selectedTicketId === ticket.id ? 'selected' : ''}`}
                      onClick={() => setSelectedTicketId(ticket.id)}
                    >
                      <div className="card-top">
                        <span className="ticket-code">{ticket.ticket_code}</span>
                        <span className={`badge severity-${ticket.severity}`}>
                          {ticket.severity}
                        </span>
                      </div>
                      <h4 className="card-title">{ticket.title}</h4>
                      <div className="card-meta">
                        <span>{ticket.customer_name}</span>
                        <span className="time-remaining">
                          ⏱ {formatTimeRemaining(ticket)}
                        </span>
                      </div>
                      <button
                        className="btn btn-claim"
                        disabled={isSubmitting}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClaim(ticket.id);
                        }}
                      >
                        Take this ticket
                      </button>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </aside>

        {/* Right Column: Ticket Workspace */}
        <main className="ticket-workspace">
          {!activeTicketData ? (
            <div className="no-ticket-selected">
              <h3>Select a ticket from the left panel to begin working</h3>
              <p>Tickets are sorted by nearest response or resolution deadline.</p>
            </div>
          ) : (
            <div className="active-ticket-view">
              {/* Ticket Details Bar */}
              <div className="ticket-detail-header">
                <div className="ticket-primary-info">
                  <div className="ticket-title-row">
                    <h2>{currentTicket.title}</h2>
                    <span className="code-pill">{currentTicket.ticket_code}</span>
                    <span className={`badge severity-${currentTicket.severity}`}>
                      {currentTicket.severity}
                    </span>
                    {currentTicket.badge === 'Late' && (
                      <span className="badge badge-late">Late</span>
                    )}
                    {currentTicket.badge === 'Waiting' && (
                      <span className="badge badge-waiting">Waiting on customer</span>
                    )}
                  </div>
                  <div className="customer-info">
                    <strong>Customer:</strong> {currentTicket.customer_name} ({currentTicket.customer_email})
                    {currentTicket.owner_name && (
                      <span className="owner-tag"> • <strong>Owner:</strong> {currentTicket.owner_name}</span>
                    )}
                  </div>
                </div>

                <div className="ticket-actions-bar">
                  {!currentTicket.owner_agent_id ? (
                    <button
                      className="btn btn-claim"
                      onClick={() => handleClaim(currentTicket.id)}
                      disabled={isSubmitting}
                    >
                      Take this ticket
                    </button>
                  ) : isOwner ? (
                    <>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleRelease(currentTicket.id)}
                        disabled={isSubmitting}
                      >
                        Release to Queue
                      </button>

                      {currentTicket.status !== 'waiting_customer' && (
                        <button
                          className="btn btn-secondary"
                          onClick={() => handleStatusChange('waiting_customer')}
                        >
                          Pause (Wait on Customer)
                        </button>
                      )}

                      {currentTicket.status !== 'resolved' && (
                        <button
                          className="btn btn-success"
                          onClick={() => handleStatusChange('resolved')}
                        >
                          Mark Resolved
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="read-only-notice">Owned by another agent</span>
                  )}
                </div>
              </div>

              {/* Deadlines Strip */}
              <div className="deadlines-strip">
                <div className="deadline-col">
                  <span className="label">First Response Deadline:</span>
                  <strong>
                    {new Date(currentTicket.first_response_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })},{' '}
                    {new Date(currentTicket.first_response_deadline).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </strong>
                  {currentTicket.first_response_at ? (
                    <span className="status-met"> (Replied)</span>
                  ) : currentTicket.first_response_breached ? (
                    <span className="status-breached"> (Breached)</span>
                  ) : null}
                </div>

                <div className="deadline-col">
                  <span className="label">Resolution Deadline:</span>
                  <strong>
                    {new Date(currentTicket.resolution_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })},{' '}
                    {new Date(currentTicket.resolution_deadline).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </strong>
                  {currentTicket.resolved_at ? (
                    <span className="status-met"> (Resolved)</span>
                  ) : currentTicket.resolution_breached ? (
                    <span className="status-breached"> (Breached)</span>
                  ) : null}
                </div>
              </div>

              {/* Message Thread */}
              <div className="conversation-thread">
                <div className="message-bubble description-bubble">
                  <div className="bubble-header">
                    <strong>{currentTicket.customer_name} (Initial Issue)</strong>
                    <span className="timestamp">{new Date(currentTicket.created_at).toLocaleString()}</span>
                  </div>
                  <div className="bubble-body">{currentTicket.description || 'No initial description.'}</div>
                </div>

                {activeTicketData.messages.map((msg) => {
                  const isInternal = msg.visibility === 'internal';
                  const isCustomer = msg.sender_type === 'customer';

                  return (
                    <div
                      key={msg.id}
                      className={`message-bubble ${
                        isInternal
                          ? 'internal-bubble'
                          : isCustomer
                          ? 'customer-bubble'
                          : 'agent-bubble'
                      }`}
                    >
                      <div className="bubble-header">
                        <strong>
                          {isInternal ? '🔒 Team only note' : msg.sender_name}
                        </strong>
                        <span className="timestamp">
                          {new Date(msg.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="bubble-body">{msg.body}</div>
                    </div>
                  );
                })}
              </div>

              {/* Reply / Note Panels */}
              <div className="reply-boxes-container">
                {/* 1. Public Reply Box */}
                <div className="reply-box public-reply-box">
                  <div className="box-title">Reply to Customer (Public)</div>
                  {!isOwner ? (
                    <div className="owner-warning">
                      Only the current ticket owner ({currentTicket.owner_name || 'unassigned'}) can send a public reply.
                    </div>
                  ) : (
                    <form onSubmit={handleSendPublicReply}>
                      <textarea
                        rows={3}
                        placeholder="Write a public reply to the customer..."
                        value={publicReplyBody}
                        onChange={e => setPublicReplyBody(e.target.value)}
                        disabled={isSubmitting}
                        required
                      />
                      <div className="form-footer">
                        <span className="hint">Stops the first response SLA clock. Customer will see this.</span>
                        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                          Send Public Reply
                        </button>
                      </div>
                    </form>
                  )}
                </div>

                {/* 2. Team-only Note Box (Rule U3: Clearly different yellow box) */}
                <div className="reply-box internal-note-box">
                  <div className="box-title yellow-title">
                    <span>🔒 Team only</span>
                    <span className="privacy-badge">Private note</span>
                  </div>
                  <form onSubmit={handleSendInternalNote}>
                    <textarea
                      rows={3}
                      placeholder="Write a private note for the team (never visible to customer)..."
                      value={internalNoteBody}
                      onChange={e => setInternalNoteBody(e.target.value)}
                      disabled={isSubmitting}
                      required
                    />
                    <div className="form-footer">
                      <span className="hint">Strictly internal. Never shown to customer in UI, API, or export.</span>
                      <button type="submit" className="btn btn-yellow" disabled={isSubmitting}>
                        Save Team Note
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Modal: New Ticket */}
      {showNewModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>Create Customer Ticket</h3>
            <form onSubmit={handleCreateTicket}>
              <div className="form-group">
                <label>Customer Name:</label>
                <input
                  type="text"
                  required
                  value={newCustomerName}
                  onChange={e => setNewCustomerName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Customer Email:</label>
                <input
                  type="email"
                  required
                  value={newCustomerEmail}
                  onChange={e => setNewCustomerEmail(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Severity:</label>
                <select value={newSeverity} onChange={e => setNewSeverity(e.target.value)}>
                  <option value="critical">Critical (Customer cannot work)</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low (Questions & requests)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Issue Title:</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Description:</label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setShowNewModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Create Ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
