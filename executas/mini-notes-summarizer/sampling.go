package main

// Reverse JSON-RPC client for `sampling/createMessage`.
//
// Direction of travel (Executa protocol v2):
//
//	host  ── invoke(id=42) ───────────────▶ this process
//	host  ◀─ sampling/createMessage(id=A) ─ this process   (reverse request)
//	host  ── response(id=A) ──────────────▶ this process   (SAME stdin stream)
//	host  ◀─ invoke result(id=42) ───────── this process
//
// Because the host's reply to our reverse request arrives on the very stdin
// that also carries ordinary requests, the main loop must keep reading while
// an invoke is blocked waiting here. server.go therefore runs every invoke in
// its own goroutine and routes response frames to dispatch() below.
//
// There is deliberately NO fallback in this file (or anywhere in the tool):
// if the host does not answer, or answers with an error, the error is
// surfaced to the caller. A summary is only ever the text the host's LLM sent
// back.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

type messageContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type samplingMessage struct {
	Role    string         `json:"role"`
	Content messageContent `json:"content"`
}

// createMessageParams mirrors the params of `sampling/createMessage` (MCP shape).
type createMessageParams struct {
	Messages       []samplingMessage `json:"messages"`
	MaxTokens      int               `json:"maxTokens"`
	SystemPrompt   string            `json:"systemPrompt,omitempty"`
	Temperature    *float64          `json:"temperature,omitempty"`
	IncludeContext string            `json:"includeContext,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type samplingUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
	TotalTokens  int `json:"totalTokens"`
}

type createMessageResult struct {
	Role       string         `json:"role"`
	Content    messageContent `json:"content"`
	Model      string         `json:"model"`
	StopReason string         `json:"stopReason"`
	Usage      samplingUsage  `json:"usage"`
}

// samplingError is an error reported by (or on behalf of) the host.
type samplingError struct {
	Code    int
	Message string
	Data    map[string]any
}

func (e *samplingError) Error() string { return fmt.Sprintf("[%d] %s", e.Code, e.Message) }

type samplingClient struct {
	out *frameWriter

	mu       sync.Mutex
	pending  map[string]chan frame
	disabled string // non-empty: host did not negotiate v2
	eof      bool   // stdin closed: no response can ever arrive
}

func newSamplingClient(out *frameWriter) *samplingClient {
	return &samplingClient{out: out, pending: map[string]chan frame{}}
}

// disable marks sampling unavailable (e.g. host did not negotiate protocol v2).
func (c *samplingClient) disable(reason string) {
	c.mu.Lock()
	c.disabled = reason
	c.mu.Unlock()
}

// createMessage writes a `sampling/createMessage` request to stdout and blocks
// until the host's response arrives on stdin, the timeout elapses, or stdin
// closes. It returns the request id it used so callers can log/audit it.
func (c *samplingClient) createMessage(p createMessageParams, timeout time.Duration) (*createMessageResult, string, error) {
	c.mu.Lock()
	if c.disabled != "" {
		reason := c.disabled
		c.mu.Unlock()
		return nil, "", &samplingError{Code: codeSamplingNotNegotiate, Message: reason}
	}
	c.mu.Unlock()

	if len(p.Messages) == 0 {
		return nil, "", errors.New("messages must be non-empty")
	}
	if p.IncludeContext == "" {
		p.IncludeContext = "none"
	}

	id, err := newRequestID()
	if err != nil {
		return nil, "", err
	}
	rawID, _ := json.Marshal(id)

	ch := make(chan frame, 1)
	c.mu.Lock()
	alreadyEOF := c.eof
	if !alreadyEOF {
		c.pending[id] = ch
	}
	c.mu.Unlock()

	// The request is ALWAYS written, even when stdin is already closed, so the
	// outgoing frame is observable (e.g. `printf ... | binary`) — the caller
	// then gets a clear "host cannot answer" error instead of a silent no-op.
	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(rawID),
		"method":  methodSamplingCreateMessage,
		"params":  p,
	}
	if err := c.out.write(req); err != nil {
		c.forget(id)
		return nil, id, fmt.Errorf("write sampling request: %w", err)
	}
	if alreadyEOF {
		return nil, id, &samplingError{Code: codeInternalError, Message: "stdin closed before the host could answer sampling/createMessage"}
	}

	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case f := <-ch:
		if f.Error != nil {
			return nil, id, &samplingError{Code: f.Error.Code, Message: f.Error.Message, Data: f.Error.Data}
		}
		var res createMessageResult
		if err := json.Unmarshal(f.Result, &res); err != nil {
			return nil, id, fmt.Errorf("decode sampling result: %w", err)
		}
		return &res, id, nil
	case <-timer.C:
		c.forget(id)
		return nil, id, &samplingError{Code: codeSamplingTimeout, Message: fmt.Sprintf("sampling/createMessage timed out after %s", timeout)}
	}
}

// dispatch hands a response frame to the invoke waiting for it. It reports
// whether the frame belonged to us (true) or should be treated as unmatched.
func (c *samplingClient) dispatch(f *frame) bool {
	var id string
	if err := json.Unmarshal(f.ID, &id); err != nil {
		return false
	}
	c.mu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if !ok {
		return false
	}
	ch <- *f // buffered(1): never blocks
	return true
}

// failAll is called when stdin reaches EOF: no response can arrive any more,
// so every waiting invoke is released with an error instead of hanging.
func (c *samplingClient) failAll(reason string) {
	c.mu.Lock()
	c.eof = true
	pend := c.pending
	c.pending = map[string]chan frame{}
	c.mu.Unlock()
	for _, ch := range pend {
		ch <- frame{Error: &rpcError{Code: codeInternalError, Message: reason}}
	}
}

func (c *samplingClient) forget(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func newRequestID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "mn-smp-" + hex.EncodeToString(b), nil
}
