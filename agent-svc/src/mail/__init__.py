"""Mail intelligence: Gmail sync, local classification, labelling, alerting.

THE RULE THIS PACKAGE EXISTS TO ENFORCE: the model describes, the rules decide.

classify.py produces an ADVISORY record from untrusted email. rules.py — a pure
function with no I/O — turns that record plus header-derived sender trust into
the only decision that reaches Gmail or the user's phone. Nothing else in this
package may escalate a message on its own.

Layering, cheapest first:
    gmail.py   Gmail REST, quota-paced, structurally unable to delete
    parse.py   MIME -> sanitized text (hidden content dropped and COUNTED)
    classify.py  local LLM under a grammar-constrained schema
    rules.py   the decision engine + the sender-trust cap
    labels.py  two orthogonal Gmail label axes
    store.py   Postgres; no email bodies are ever written
    worker.py  the daemon thread that sequences all of it

Unlike tools/, this package MAY call an LLM: it runs on its own thread, not on
the SSE queue-drain thread that a nested LLM call would deadlock.
"""
