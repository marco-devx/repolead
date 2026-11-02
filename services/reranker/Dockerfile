FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir transformers==5.22.1 fastapi==0.162.0 uvicorn==0.54.0
COPY server.py /app/server.py
ENV HF_HOME=/data PYTHONUNBUFFERED=1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "80"]
