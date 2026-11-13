REPOLEAD_CLOUD_ENV ?= .env.cloud
REPOS_DIR ?= .
REPOS_FILE ?= .repolead/cloud/repositories.json
REPOLEAD_CLI = bun apps/cli/dist/index.cjs cloud --env-file "$(REPOLEAD_CLOUD_ENV)"
GPU_LOCK ?= /tmp/repolead-gpu-$(shell id -u).lock

.PHONY: cloud-init cloud-up cloud-build producto-preparar producto-publicar producto-worker producto-worker-container producto-migrar-vectores producto-refrescar cloud-grant
cloud-build:
	docker compose --env-file "$(REPOLEAD_CLOUD_ENV)" -f docker-compose.cloud.yml build mcp
cloud-init:
	$(REPOLEAD_CLI) migrate
cloud-up:
	docker compose --env-file "$(REPOLEAD_CLOUD_ENV)" -f docker-compose.cloud.yml up -d mcp
producto-preparar:
	$(REPOLEAD_CLI) publish --dir "$(REPOS_DIR)" --repos-file "$(REPOS_FILE)" --dry-run
producto-publicar:
	$(REPOLEAD_CLI) publish --dir "$(REPOS_DIR)" --repos-file "$(REPOS_FILE)"
producto-worker:
	$(REPOLEAD_CLI) worker
producto-worker-container:
	touch "$(GPU_LOCK)"
	REPOLEAD_GPU_LOCK_HOST="$(GPU_LOCK)" docker compose --env-file "$(REPOLEAD_CLOUD_ENV)" -f docker-compose.cloud.yml --profile local-worker up -d worker
producto-migrar-vectores:
	$(REPOLEAD_CLI) import-vectors --dir "$(REPOS_DIR)" --repos-file "$(REPOS_FILE)"
producto-refrescar:
	$(REPOLEAD_CLI) refresh-workspace --dir "$(REPOS_DIR)"
cloud-grant:
	$(REPOLEAD_CLI) grant "$(EMAIL)" --all
