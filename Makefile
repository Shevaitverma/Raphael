# Raphael walking skeleton — convenience targets.
# On Windows, run these from Git Bash (the recipes are POSIX sh) with Go on PATH:
#   export PATH="$PATH:/c/Program Files/Go/bin"
.DEFAULT_GOAL := help
SHELL := bash

.PHONY: help up down dev stop health e2e test

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-10s %s\n",$$1,$$2}'

up: ## Start infrastructure (Postgres :5433, Redis :6379)
	docker compose up -d

down: ## Stop infrastructure
	docker compose down

dev: ## Build + start all five services on the host
	bash scripts/dev.sh

stop: ## Stop host services started by `make dev` (by pid files, then by port)
	@for f in logs/*.pid; do [ -f "$$f" ] && kill $$(cat "$$f") 2>/dev/null && echo "stopped $$f"; done; true
	@for p in 8080 8081 8082 8000 3000; do \
	  pid=$$(netstat -ano -p tcp 2>/dev/null | grep LISTENING | grep ":$$p " | awk '{print $$5}' | head -1); \
	  [ -n "$$pid" ] && taskkill //F //PID $$pid >/dev/null 2>&1 && echo "killed :$$p"; done; true

health: ## Curl every /healthz
	@for p in 8082 8081 8000 8080; do echo "== :$$p =="; curl -s http://localhost:$$p/healthz; echo; done

e2e: ## Run the end-to-end acceptance test
	bash scripts/e2e.sh

test: ## Run every service's own test suite
	export PATH="$$PATH:/c/Program Files/Go/bin"; \
	( cd conv-svc && go test ./... ) && \
	( cd gateway && go test ./... ) && \
	( cd user-svc && go test ./... ) && \
	( cd agent-svc && HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv/Scripts/python.exe -m pytest -q )
