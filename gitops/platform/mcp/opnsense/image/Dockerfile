# opnsense-mcp-server over streamable HTTP (../../README.md).
FROM python:3.13-alpine@sha256:bf12ecc0bea3f171d55145dd02c78b5eeb09f30ee2ac9cc2b4c9e4e8f5e30741
# httpx: imported by opnsense_mcp but not declared as a dependency
RUN pip install --no-cache-dir opnsense-mcp-server==0.4.1 fastmcp==4.0.10 httpx==0.28.1
COPY serve.py /app/serve.py
USER 1000
EXPOSE 8080
ENTRYPOINT ["python", "/app/serve.py"]
