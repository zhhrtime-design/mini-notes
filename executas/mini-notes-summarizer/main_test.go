package main

// End-to-end protocol tests. A fake "host" drives the server through in-memory
// pipes exactly like Anna's agent does over stdio, including answering the
// reverse `sampling/createMessage` request on the SAME stdin stream.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type testHost struct {
	t      *testing.T
	in     *io.PipeWriter
	frames chan map[string]any
	raw    []string // every stdout line, for the "stdout is JSON-RPC only" check
	rawMu  sync.Mutex
	stderr *syncBuf
	done   chan struct{}
}

func startHost(t *testing.T) *testHost {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &testHost{t: t, in: inW, frames: make(chan map[string]any, 64), stderr: &syncBuf{}, done: make(chan struct{})}

	srv := newServer(outW, h.stderr)
	go func() {
		srv.run(inR)
		_ = outW.Close()
		close(h.done)
	}()
	go func() {
		sc := bufio.NewScanner(outR)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			line := sc.Text()
			h.rawMu.Lock()
			h.raw = append(h.raw, line)
			h.rawMu.Unlock()
			var m map[string]any
			if err := json.Unmarshal([]byte(line), &m); err != nil {
				t.Errorf("stdout line is not JSON: %q", line)
				continue
			}
			h.frames <- m
		}
		close(h.frames)
	}()
	return h
}

func (h *testHost) send(v any) {
	h.t.Helper()
	b, _ := json.Marshal(v)
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		h.t.Fatalf("write to server stdin: %v", err)
	}
}

func (h *testHost) next() map[string]any {
	h.t.Helper()
	select {
	case f, ok := <-h.frames:
		if !ok {
			h.t.Fatal("server closed stdout unexpectedly")
		}
		return f
	case <-time.After(5 * time.Second):
		h.t.Fatal("timed out waiting for a frame from the server")
		return nil
	}
}

func (h *testHost) req(id int, method string, params any) {
	m := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		m["params"] = params
	}
	h.send(m)
}

func (h *testHost) close() {
	_ = h.in.Close()
	select {
	case <-h.done:
	case <-time.After(5 * time.Second):
		h.t.Fatal("server did not exit after stdin EOF")
	}
}

var sampleNotes = []map[string]any{
	{"seq": 1, "text": "明天跟客户 follow up"},
	{"seq": 2, "text": "修复登录 bug"},
	{"seq": 3, "text": "Workshop 内容想法"},
}

func initV2(h *testHost) {
	h.req(1, "initialize", map[string]any{"protocolVersion": "2.0"})
	f := h.next()
	res := f["result"].(map[string]any)
	if res["protocolVersion"] != "2.0" {
		h.t.Fatalf("protocolVersion = %v, want 2.0", res["protocolVersion"])
	}
	caps := res["client_capabilities"].(map[string]any)
	if _, ok := caps["sampling"]; !ok {
		h.t.Fatalf("client_capabilities must declare sampling, got %v", caps)
	}
}

func TestInitializeNegotiatesV2AndDeclaresSampling(t *testing.T) {
	h := startHost(t)
	initV2(h)
	h.close()
}

func TestInitializeV1DoesNotDeclareSamplingAndInvokeFails(t *testing.T) {
	h := startHost(t)
	h.req(1, "initialize", map[string]any{"protocolVersion": "1.1"})
	res := h.next()["result"].(map[string]any)
	if caps := res["client_capabilities"].(map[string]any); len(caps) != 0 {
		t.Fatalf("v1 must not declare sampling, got %v", caps)
	}
	h.req(2, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": sampleNotes}, "invoke_id": "inv-v1"})
	f := h.next()
	e, ok := f["error"].(map[string]any)
	if !ok || int(e["code"].(float64)) != codeSamplingNotNegotiate {
		t.Fatalf("expected -32008 NOT_NEGOTIATED, got %v", f)
	}
	h.close()
}

func TestDescribeReturnsBareManifest(t *testing.T) {
	h := startHost(t)
	h.req(7, "describe", nil)
	f := h.next()
	m := f["result"].(map[string]any)
	for _, k := range []string{"name", "display_name", "version", "description", "host_capabilities", "tools", "runtime"} {
		if _, ok := m[k]; !ok {
			t.Errorf("describe result missing %q", k)
		}
	}
	if m["name"] != toolSlug {
		t.Errorf("name = %v, want %s", m["name"], toolSlug)
	}
	caps := m["host_capabilities"].([]any)
	if len(caps) != 1 || caps[0] != "llm.sample" {
		t.Errorf("host_capabilities = %v, want [llm.sample]", caps)
	}
	tool := m["tools"].([]any)[0].(map[string]any)
	if tool["name"] != "summarize" {
		t.Errorf("tool name = %v", tool["name"])
	}
	if _, bad := tool["input_schema"]; bad {
		t.Error("tool must use parameters[], not MCP input_schema")
	}
	params := tool["parameters"].([]any)
	if len(params) < 1 || params[0].(map[string]any)["name"] != "notes" {
		t.Errorf("parameters = %v", params)
	}
	h.close()
}

// The core chain: invoke -> reverse sampling/createMessage -> host response on
// the same stdin -> invoke result carrying EXACTLY the host's text.
func TestInvokeSummarizeUsesReverseSampling(t *testing.T) {
	h := startHost(t)
	initV2(h)

	h.req(2, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": sampleNotes}, "invoke_id": "inv-123"})

	// 1) The tool must call back into the host.
	sreq := h.next()
	if sreq["method"] != "sampling/createMessage" {
		t.Fatalf("expected reverse sampling/createMessage, got %v", sreq)
	}
	params := sreq["params"].(map[string]any)
	meta := params["metadata"].(map[string]any)
	if meta["executa_invoke_id"] != "inv-123" {
		t.Errorf("metadata.executa_invoke_id = %v, want inv-123", meta["executa_invoke_id"])
	}
	prompt := params["messages"].([]any)[0].(map[string]any)["content"].(map[string]any)["text"].(string)
	for _, want := range []string{"明天跟客户 follow up", "修复登录 bug", "Workshop 内容想法", "#1:", "#3:"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("sampling prompt missing %q:\n%s", want, prompt)
		}
	}
	if params["maxTokens"].(float64) <= 0 {
		t.Error("maxTokens must be > 0")
	}

	// 2) The host answers on the same stdin stream.
	const hostText = "HOST-LLM-ANSWER: follow up client, fix login bug, plan workshop."
	h.send(map[string]any{
		"jsonrpc": "2.0", "id": sreq["id"],
		"result": map[string]any{
			"role": "assistant", "content": map[string]any{"type": "text", "text": hostText},
			"model": "mock-model", "stopReason": "endTurn",
			"usage": map[string]any{"inputTokens": 10, "outputTokens": 12, "totalTokens": 22},
		},
	})

	// 3) invoke result carries the host's text verbatim.
	f := h.next()
	res := f["result"].(map[string]any)
	data := res["data"].(map[string]any)
	if res["success"] != true || res["tool"] != "summarize" {
		t.Fatalf("bad invoke envelope: %v", res)
	}
	if data["summary"] != hostText {
		t.Errorf("summary = %q, want the host's text %q", data["summary"], hostText)
	}
	if data["source"] != "sampling/createMessage" || data["sampling_request_id"] != sreq["id"] {
		t.Errorf("audit fields wrong: %v", data)
	}
	if data["invoke_id"] != "inv-123" || data["note_count"].(float64) != 3 {
		t.Errorf("audit fields wrong: %v", data)
	}
	if !strings.Contains(h.stderr.String(), "→ sampling/createMessage invoke_id=inv-123") {
		t.Errorf("stderr should log the sampling request, got:\n%s", h.stderr.String())
	}
	h.close()
}

// Proves the summary is not rule-based: different host text => different summary.
func TestSummaryAlwaysComesFromHostText(t *testing.T) {
	for _, hostText := range []string{"alpha", "完全不同的总结 ✓", "zzz 12345"} {
		h := startHost(t)
		initV2(h)
		h.req(2, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": sampleNotes}})
		sreq := h.next()
		h.send(map[string]any{"jsonrpc": "2.0", "id": sreq["id"], "result": map[string]any{
			"role": "assistant", "content": map[string]any{"type": "text", "text": hostText}, "model": "m", "stopReason": "endTurn"}})
		got := h.next()["result"].(map[string]any)["data"].(map[string]any)["summary"]
		if got != hostText {
			t.Errorf("summary = %q, want %q", got, hostText)
		}
		h.close()
	}
}

func TestSamplingErrorIsPropagatedNotFaked(t *testing.T) {
	h := startHost(t)
	initV2(h)
	h.req(2, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": sampleNotes}})
	sreq := h.next()
	h.send(map[string]any{"jsonrpc": "2.0", "id": sreq["id"],
		"error": map[string]any{"code": -32001, "message": "sampling not granted"}})
	f := h.next()
	if _, hasResult := f["result"]; hasResult {
		t.Fatalf("must not return a result when sampling failed: %v", f)
	}
	e := f["error"].(map[string]any)
	if int(e["code"].(float64)) != -32001 || !strings.Contains(e["message"].(string), "not granted") {
		t.Errorf("error not propagated: %v", e)
	}
	h.close()
}

func TestInvokeValidation(t *testing.T) {
	h := startHost(t)
	initV2(h)

	h.req(2, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": []any{}}})
	f := h.next()
	if int(f["error"].(map[string]any)["code"].(float64)) != codeInvalidParams {
		t.Errorf("empty notes should be -32602, got %v", f)
	}

	h.req(3, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": []any{map[string]any{"seq": 1, "text": "   "}}}})
	f = h.next()
	if int(f["error"].(map[string]any)["code"].(float64)) != codeInvalidParams {
		t.Errorf("blank-only notes should be -32602, got %v", f)
	}

	h.req(4, "invoke", map[string]any{"tool": "nope", "arguments": map[string]any{}})
	f = h.next()
	if int(f["error"].(map[string]any)["code"].(float64)) != codeMethodNotFound {
		t.Errorf("unknown tool should be -32601, got %v", f)
	}

	h.req(5, "does/not/exist", nil)
	f = h.next()
	if int(f["error"].(map[string]any)["code"].(float64)) != codeMethodNotFound {
		t.Errorf("unknown method should be -32601, got %v", f)
	}
	h.close()
}

// One process must serve many requests until EOF (not exit after the first).
func TestKeepsServingUntilEOF(t *testing.T) {
	h := startHost(t)
	for i := 1; i <= 5; i++ {
		h.req(i, "health", nil)
		f := h.next()
		if int(f["id"].(float64)) != i || f["result"].(map[string]any)["status"] != "healthy" {
			t.Fatalf("request %d: bad health response %v", i, f)
		}
	}
	h.req(6, "shutdown", nil)
	if h.next()["result"].(map[string]any)["ok"] != true {
		t.Fatal("shutdown should ack")
	}
	h.req(7, "describe", nil) // still alive after shutdown ack, until EOF
	if _, ok := h.next()["result"]; !ok {
		t.Fatal("process must keep reading until EOF")
	}
	h.close()
}

func TestNotificationsGetNoResponseAndParseErrorsAreReported(t *testing.T) {
	h := startHost(t)
	h.send(map[string]any{"jsonrpc": "2.0", "method": "health"}) // no id => notification
	if _, err := h.in.Write([]byte("this is not json\n")); err != nil {
		t.Fatal(err)
	}
	f := h.next() // the only frame must be the parse error
	if int(f["error"].(map[string]any)["code"].(float64)) != codeParseError || f["id"] != nil {
		t.Errorf("expected parse error with null id, got %v", f)
	}
	h.close()
}

// `printf '<invoke>' | binary`: stdin closes right away. The sampling request
// must still be written (observable evidence) and invoke must end with an
// error — never hang, never invent a summary.
func TestEOFAfterInvokeStillEmitsSamplingRequest(t *testing.T) {
	h := startHost(t)
	h.req(1, "invoke", map[string]any{"tool": "summarize", "arguments": map[string]any{"notes": sampleNotes}, "invoke_id": "inv-eof"})
	h.close() // EOF immediately

	var sawSampling, sawError bool
	for f := range h.frames {
		if f["method"] == "sampling/createMessage" {
			sawSampling = true
		}
		if e, ok := f["error"].(map[string]any); ok && f["id"] == float64(1) {
			sawError = true
			if _, has := f["result"]; has {
				t.Error("must not return a result without a host answer")
			}
			_ = e
		}
	}
	if !sawSampling || !sawError {
		t.Errorf("sawSampling=%v sawError=%v", sawSampling, sawError)
	}
}

// stdout must carry JSON-RPC frames only — logs belong on stderr.
func TestStdoutIsJSONRPCOnly(t *testing.T) {
	h := startHost(t)
	initV2(h)
	h.req(2, "describe", nil)
	h.next()
	h.req(3, "health", nil)
	h.next()
	h.close()
	h.rawMu.Lock()
	defer h.rawMu.Unlock()
	for _, line := range h.raw {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil || m["jsonrpc"] != "2.0" {
			t.Errorf("non JSON-RPC line on stdout: %q", line)
		}
	}
	if !strings.Contains(h.stderr.String(), "started v") {
		t.Error("expected startup log on stderr")
	}
}
