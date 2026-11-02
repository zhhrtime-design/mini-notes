package main

import (
	_ "embed"
	"strings"
)

// toolSlug is the Executa's identity. It MUST stay identical to:
//   - manifest.json            required_executas[].tool_id  ("bundled:<slug>")
//   - src/config.ts            TOOL_SLUG
//   - executa.json             tool_id ("tool-test-<slug>-12345678" in local dev)
//   - the archive manifest     "name" written by scripts/package_executa.py
const (
	toolSlug      = "mini-notes-summarizer"
	toolSummarize = "summarize"
)

// VERSION is the single source of truth for the release version; the
// packaging script reads the same file.
//
//go:embed VERSION
var versionFile string

func version() string { return strings.TrimSpace(versionFile) }

// manifest is the bare manifest returned by `describe`. Tool parameters use
// the Anna Executa `parameters[]` form (NOT MCP-style `input_schema`).
type manifest struct {
	Name             string         `json:"name"`
	DisplayName      string         `json:"display_name"`
	Version          string         `json:"version"`
	Description      string         `json:"description"`
	Author           string         `json:"author"`
	HostCapabilities []string       `json:"host_capabilities"`
	Tools            []toolSpec     `json:"tools"`
	Runtime          map[string]any `json:"runtime"`
}

type toolSpec struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  []paramSpec `json:"parameters"`
}

type paramSpec struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Required    bool   `json:"required"`
	ItemsType   string `json:"items_type,omitempty"`
	Default     any    `json:"default,omitempty"`
}

func buildManifest() manifest {
	return manifest{
		Name:        toolSlug,
		DisplayName: "Mini Notes Summarizer",
		Version:     version(),
		Description: "Summarizes a list of short notes by asking the host LLM to sample " +
			"(reverse JSON-RPC sampling/createMessage). The tool never writes the summary itself.",
		Author: "Mini Notes",
		// Without "llm.sample" the host refuses reverse sampling (-32008 NOT_NEGOTIATED).
		HostCapabilities: []string{"llm.sample"},
		Tools: []toolSpec{
			{
				Name: toolSummarize,
				Description: "Summarize the given notes into one short paragraph. " +
					"The summary text is produced by the host LLM via sampling/createMessage.",
				Parameters: []paramSpec{
					{
						Name:        "notes",
						Type:        "array",
						ItemsType:   "object",
						Description: "Notes in the order they were added: [{seq: integer, text: string}].",
						Required:    true,
					},
					{
						Name:        "max_words",
						Type:        "integer",
						Description: "Approximate maximum words in the summary (20-400).",
						Required:    false,
						Default:     80,
					},
				},
			},
		},
		Runtime: map[string]any{"type": "binary"},
	}
}
