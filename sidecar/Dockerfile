FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NLM_AUTH_DIR=/auth \
    NLM_PROFILE=default \
    PORT=8000

WORKDIR /app

# WHY requirements first: dependency layer stays cached across code edits.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config.py logging_setup.py errors.py nlm_client.py schemas.py main.py ./

# WHY a non-root user: the container mounts a long-lived master token at /auth
# and should not be able to write anywhere outside its own workdir.
RUN useradd --create-home --uid 10001 sidecar \
    && mkdir -p /auth \
    && chown -R sidecar:sidecar /app
USER sidecar

EXPOSE 8000

# WHY urllib rather than curl: no extra apt layer, and /health is plain JSON.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8000'), timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
