"""Tools the model may ask us to run.

One rule, and it is the trust boundary: a tool does I/O and returns DATA. It
never calls an LLM. main.py runs workflow.run on a daemon thread draining a
queue.Queue, so an LLM call nested inside a tool handler deadlocks the drain.
"""
from tools import google, search

__all__ = ["google", "search"]
