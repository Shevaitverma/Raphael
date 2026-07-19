package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// Tasks are public, uid-scoped per-user data (like profile): no requireInternal.
// The gateway forces uid from the JWT into the path. Title/status are validated
// in Go before the DB so a CHECK violation never surfaces as a 500; non-uuid
// uid/id resolve to 404 via the store's validUUID guards.

// parseDueDate validates the optional YYYY-MM-DD input. Empty -> cleared (nil).
// The store passes the *string straight to a $n::date placeholder.
func parseDueDate(s string) (*string, bool) {
	if s == "" {
		return nil, true
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return nil, false
	}
	return &s, true
}

// validPriority reports whether p is one of the four select values (mirrors the
// tasks_priority_check CHECK so an invalid value is a clean 400, never a 500).
func validPriority(p string) bool {
	switch p {
	case "none", "low", "medium", "high":
		return true
	}
	return false
}

func (s *server) listTasks(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	tasks, err := s.store.listTasks(r.Context(), uid)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to list tasks")
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

type createTaskReq struct {
	Title    string `json:"title"`
	Notes    string `json:"notes"`
	DueDate  string `json:"due_date"`
	Priority string `json:"priority"`
}

func (s *server) createTask(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")

	var req createTaskReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeErr(w, http.StatusBadRequest, "title must not be blank")
		return
	}
	if utf8.RuneCountInString(title) > 200 {
		writeErr(w, http.StatusBadRequest, "title must be at most 200 characters")
		return
	}
	dueDate, ok := parseDueDate(req.DueDate)
	if !ok {
		writeErr(w, http.StatusBadRequest, "due_date must be a YYYY-MM-DD date")
		return
	}
	// Priority is optional on create; empty means the default 'none'.
	priority := req.Priority
	if priority == "" {
		priority = "none"
	}
	if !validPriority(priority) {
		writeErr(w, http.StatusBadRequest, "priority must be none, low, medium or high")
		return
	}

	t, err := s.store.createTask(r.Context(), uid, title, req.Notes, priority, dueDate)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "user not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to create task")
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

// patchTask applies any subset of {title,notes,status,priority,position,due_date}. Decoding into a
// raw-message map is what lets "key absent" differ from "key present but null":
// only present keys land in the map, so due_date:null clears the date while an
// omitted due_date leaves it untouched. Absent title/notes/status stay untouched.
func (s *server) patchTask(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	id := r.PathValue("id")

	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	sets := map[string]any{}
	for key, val := range raw {
		switch key {
		case "title":
			var t string
			if json.Unmarshal(val, &t) != nil {
				writeErr(w, http.StatusBadRequest, "title must be a string")
				return
			}
			t = strings.TrimSpace(t)
			if t == "" || utf8.RuneCountInString(t) > 200 {
				writeErr(w, http.StatusBadRequest, "title must be 1..200 characters")
				return
			}
			sets["title"] = t
		case "notes":
			var n string
			if json.Unmarshal(val, &n) != nil {
				writeErr(w, http.StatusBadRequest, "notes must be a string")
				return
			}
			sets["notes"] = n
		case "status":
			var st string
			if json.Unmarshal(val, &st) != nil {
				writeErr(w, http.StatusBadRequest, "status must be a string")
				return
			}
			if st != "open" && st != "in_progress" && st != "done" {
				writeErr(w, http.StatusBadRequest, "status must be open, in_progress or done")
				return
			}
			sets["status"] = st
		case "priority":
			var p string
			if json.Unmarshal(val, &p) != nil {
				writeErr(w, http.StatusBadRequest, "priority must be a string")
				return
			}
			if !validPriority(p) {
				writeErr(w, http.StatusBadRequest, "priority must be none, low, medium or high")
				return
			}
			sets["priority"] = p
		case "position":
			var pos float64
			if json.Unmarshal(val, &pos) != nil {
				writeErr(w, http.StatusBadRequest, "position must be a number")
				return
			}
			sets["position"] = pos
		case "due_date":
			// present-but-null (or "") clears; a string is validated as a date.
			var d *string
			if json.Unmarshal(val, &d) != nil {
				writeErr(w, http.StatusBadRequest, "due_date must be a YYYY-MM-DD date or null")
				return
			}
			s := ""
			if d != nil {
				s = *d
			}
			parsed, ok := parseDueDate(s)
			if !ok {
				writeErr(w, http.StatusBadRequest, "due_date must be a YYYY-MM-DD date or null")
				return
			}
			sets["due_date"] = parsed
		default:
			writeErr(w, http.StatusBadRequest, "unknown field: "+key)
			return
		}
	}

	t, err := s.store.updateTask(r.Context(), uid, id, sets)
	if err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "task not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to update task")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) deleteTask(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	id := r.PathValue("id")

	if err := s.store.deleteTask(r.Context(), uid, id); err != nil {
		if errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "task not found for this user")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete task")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}
