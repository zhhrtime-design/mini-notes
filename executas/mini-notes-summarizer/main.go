// mini-notes-summarizer — Anna Executa tool (JSON-RPC 2.0 over stdio).
//
// It exposes one tool, `summarize`, and implements it by asking the HOST to
// run an LLM completion through reverse `sampling/createMessage`. No API key,
// no network access and no local summarisation logic live in this binary.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type server struct {
	out      *frameWriter
	sampling *samplingClient
	logw     io.Writer // stderr — NEVER stdout
	wg       sync.WaitGroup
}

func newServer(out io.Writer, logw io.Writer) *server {
	fw := newFrameWriter(out)
	return &server{out: fw, sampling: newSamplingClient(fw), logw: logw}
}

func (s *server) logf(format string, a ...any) {
	fmt.Fprintf(s.logw, "[mini-notes-summarizer] "+format+"\n", a...)
}

// run reads newline-delimited JSON-RPC frames from in until EOF. It does not
// return after the first request: one process serves many requests.
func (s *server) run(in io.Reader) {
	s.logf("started v%s (pid=%d)", version(), os.Getpid())

	r := bufio.NewReaderSize(in, 1<<20) // no hard line-length cap
	for {
		line, err := r.ReadBytes('\n')
		if t := strings.TrimSpace(string(line)); t != "" {
			// Copy: ReadBytes returns a fresh slice, but handlers run async.
			s.handleLine([]byte(t))
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.logf("stdin read error: %v", err)
			}
			break
		}
	}

	// EOF: no host response can arrive any more. Release invokes still waiting
	// on sampling, let them write their (error) responses, then exit.
	s.sampling.failAll("stdin closed before the host answered sampling/createMessage")
	s.wg.Wait()
	s.logf("stdin closed, exiting")
}

func (s *server) handleLine(line []byte) {
	var f frame
	if err := json.Unmarshal(line, &f); err != nil {
		_ = s.out.write(errResponse(nil, &rpcError{Code: codeParseError, Message: "Parse error"}))
		return
	}

	// A frame without a method is the host's response to one of OUR reverse
	// requests (sampling/createMessage) — it shares this stdin stream.
	if f.isResponse() {
		if !s.sampling.dispatch(&f) {
			s.logf("unmatched response id=%s (ignored)", string(f.ID))
		}
		return
	}

	switch f.Method {
	case methodInitialize:
		s.reply(&f, s.handleInitialize(f.Params), nil)
	case methodDescribe:
		s.reply(&f, buildManifest(), nil) // bare manifest, not wrapped
	case methodHealth:
		s.reply(&f, map[string]any{
			"status":    "healthy",
			"version":   version(),
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		}, nil)
	case methodShutdown:
		// Acknowledge only. The process keeps reading until the host closes
		// stdin (EOF), which is how a v2 host ends the session.
		s.reply(&f, map[string]any{"ok": true}, nil)
	case methodInvoke:
		// Must NOT run on the reader goroutine: while this invoke waits for
		// sampling, the reader has to keep consuming stdin to receive the
		// host's response frame.
		s.wg.Add(1)
		go func(f frame) {
			defer s.wg.Done()
			s.handleInvoke(&f)
		}(f)
	default:
		s.reply(&f, nil, &rpcError{Code: codeMethodNotFound, Message: "Method not found: " + f.Method})
	}
}

// reply answers a request; notifications (no id) get no response.
func (s *server) reply(req *frame, result any, e *rpcError) {
	if len(req.ID) == 0 {
		return
	}
	var resp response
	if e != nil {
		resp = errResponse(req.ID, e)
	} else {
		resp = okResponse(req.ID, result)
	}
	if err := s.out.write(resp); err != nil {
		s.logf("write response failed: %v", err)
	}
}

func (s *server) handleInitialize(raw json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.ProtocolVersion == "" {
		p.ProtocolVersion = protocolV1
	}

	negotiated := protocolV1
	caps := map[string]any{}
	if p.ProtocolVersion == protocolV2 {
		negotiated = protocolV2
		// Declares that this process will issue reverse sampling requests.
		caps["sampling"] = map[string]any{}
	} else {
		s.sampling.disable(fmt.Sprintf(
			"host did not negotiate protocol v2 (offered %q); sampling/createMessage requires Executa protocol 2.0",
			p.ProtocolVersion))
	}
	m := buildManifest()
	return map[string]any{
		"protocolVersion":     negotiated,
		"serverInfo":          map[string]any{"name": m.DisplayName, "version": m.Version},
		"client_capabilities": caps,
		"capabilities":        map[string]any{},
	}
}

func (s *server) handleInvoke(f *frame) {
	var p struct {
		Tool      string          `json:"tool"`
		Name      string          `json:"name"` // tolerated alias of "tool"
		Arguments json.RawMessage `json:"arguments"`
		InvokeID  string          `json:"invoke_id"`
	}
	if err := json.Unmarshal(f.Params, &p); err != nil {
		s.reply(f, nil, &rpcError{Code: codeInvalidParams, Message: "invalid invoke params: " + err.Error()})
		return
	}
	tool := p.Tool
	if tool == "" {
		tool = p.Name
	}
	if tool != toolSummarize {
		s.reply(f, nil, &rpcError{Code: codeMethodNotFound, Message: "Unknown tool: " + tool})
		return
	}

	// Correlation id for audit: the host's invoke_id, or (when a bare client
	// does not send one) the JSON-RPC request id as an equivalent.
	rpcID := strings.Trim(string(f.ID), `"`)
	correlation := p.InvokeID
	if correlation == "" {
		correlation = "rpc-" + rpcID
	}

	data, err := s.summarize(p.Arguments, correlation, rpcID)
	if err != nil {
		var ip invalidParams
		var se *samplingError
		switch {
		case errors.As(err, &ip):
			s.reply(f, nil, &rpcError{Code: codeInvalidParams, Message: "Invalid params: " + ip.Error()})
		case errors.As(err, &se):
			s.reply(f, nil, &rpcError{Code: se.Code, Message: se.Message, Data: se.Data})
		default:
			s.reply(f, nil, &rpcError{Code: codeInternalError, Message: "Tool execution failed: " + err.Error()})
		}
		return
	}
	s.reply(f, map[string]any{"success": true, "tool": toolSummarize, "data": data}, nil)
}

func main() {
	newServer(os.Stdout, os.Stderr).run(os.Stdin)
}
