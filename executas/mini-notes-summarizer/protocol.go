package main

// JSON-RPC 2.0 plumbing for the Executa stdio protocol.
//
// Rules this file exists to enforce:
//   - stdout carries JSON-RPC frames ONLY, one per line. Every write goes
//     through frameWriter, which serialises writers with a mutex so frames
//     from concurrent invokes and reverse sampling calls never interleave.
//   - Logs go to stderr (see server.logf), never to stdout.
//   - os.Stdout is unbuffered in Go, so each frame is on the wire as soon as
//     Write returns — that is the "flush after every response" requirement.

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

const (
	protocolV1 = "1.1"
	protocolV2 = "2.0"

	methodInitialize = "initialize"
	methodDescribe   = "describe"
	methodInvoke     = "invoke"
	methodHealth     = "health"
	methodShutdown   = "shutdown"

	// Reverse request: this process -> host.
	methodSamplingCreateMessage = "sampling/createMessage"

	// Standard JSON-RPC error codes.
	codeParseError     = -32700
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603

	// Executa v2 sampling error codes (mirrors the host protocol).
	codeSamplingNotGranted   = -32001
	codeSamplingTimeout      = -32005
	codeSamplingNotNegotiate = -32008
)

// frame is any JSON-RPC message on the wire: a request/notification (Method
// set), or a response (Result or Error set). The same stdin stream carries
// requests from the host AND the host's responses to our reverse requests,
// so every inbound line is decoded into this one shape first.
type frame struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func (f *frame) isResponse() bool {
	return f.Method == "" && (len(f.Result) > 0 || f.Error != nil)
}

type rpcError struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("[%d] %s", e.Code, e.Message) }

// response is what we send back for a host request.
type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func okResponse(id json.RawMessage, result any) response {
	return response{JSONRPC: "2.0", ID: idOrNull(id), Result: result}
}

func errResponse(id json.RawMessage, e *rpcError) response {
	return response{JSONRPC: "2.0", ID: idOrNull(id), Error: e}
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

// frameWriter serialises newline-delimited JSON frames onto one writer.
type frameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func newFrameWriter(w io.Writer) *frameWriter { return &frameWriter{w: w} }

func (fw *frameWriter) write(msg any) error {
	buf, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	buf = append(buf, '\n')
	fw.mu.Lock()
	defer fw.mu.Unlock()
	_, err = fw.w.Write(buf)
	return err
}
