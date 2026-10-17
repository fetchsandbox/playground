# Verified existing Python dependency image; contains no deployed credentials.
FROM 342206308838.dkr.ecr.us-west-2.amazonaws.com/quote-agent-agentcore@sha256:4ee5c34c99a45b934423d23a677332e9c9f39a1e6ce72946964b8db00ea4f185
WORKDIR /app/refund-operations
COPY refund_ops ./refund_ops
COPY policies ./policies
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "refund_ops.app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
