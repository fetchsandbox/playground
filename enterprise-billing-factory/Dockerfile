FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY runtime.py .
COPY prepare.py .
COPY fixtures ./fixtures
RUN useradd --uid 10001 --create-home demo
USER demo
CMD ["python", "runtime.py", "serve-worker"]
