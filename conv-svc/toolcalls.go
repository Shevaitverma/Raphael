package main

import (
	"encoding/json"
	"fmt"
)

// validateToolCalls enforces OUR neutral tool-call shape and rejects any
// provider wire format. The neutral shape is:
//
//	[ { "name": "<string>", "arguments": { ... } }, ... ]
//
// Rules:
//   - top level MUST be a JSON array
//   - every element MUST be a JSON object
//   - "name" is required and MUST be a non-empty string
//   - "arguments" is required and MUST be a JSON object
//   - no other keys are allowed. This is what bars provider leakage:
//     Anthropic's `id`/`type`/`input`, OpenAI's `id`/`type`/`function`,
//     thinking-block signatures, cache markers — all rejected here.
func validateToolCalls(raw json.RawMessage) error {
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return fmt.Errorf("tool_calls must be a JSON array of objects")
	}
	for i, tc := range arr {
		nameRaw, ok := tc["name"]
		if !ok {
			return fmt.Errorf("tool_calls[%d]: missing required field \"name\"", i)
		}
		var name string
		if err := json.Unmarshal(nameRaw, &name); err != nil || name == "" {
			return fmt.Errorf("tool_calls[%d]: \"name\" must be a non-empty string", i)
		}

		argsRaw, ok := tc["arguments"]
		if !ok {
			return fmt.Errorf("tool_calls[%d]: missing required field \"arguments\"", i)
		}
		var args map[string]json.RawMessage
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return fmt.Errorf("tool_calls[%d]: \"arguments\" must be a JSON object", i)
		}

		for k := range tc {
			if k != "name" && k != "arguments" {
				return fmt.Errorf("tool_calls[%d]: unexpected field %q; only \"name\" and \"arguments\" are allowed (no provider wire format)", i, k)
			}
		}
	}
	return nil
}
