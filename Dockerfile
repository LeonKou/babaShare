FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BABA_SHARE_HOST=0.0.0.0 \
    BABA_SHARE_DATA_DIR=/var/lib/baba-share

WORKDIR /opt/baba-share
COPY --chown=10001:10001 server.py ./
COPY --chown=10001:10001 backend/ ./backend/
COPY --chown=10001:10001 web/ ./web/
RUN mkdir -p /var/lib/baba-share && chown 10001:10001 /var/lib/baba-share
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["python", "-c", "import http.client,os; c=http.client.HTTPConnection('127.0.0.1',int(os.environ.get('BABA_SHARE_PORT','8080')),timeout=3); c.request('GET','/baba-share/'); r=c.getresponse(); assert r.status==200 and r.getheader('Server','').startswith('babaShare'); r.read(); c.close()"]
CMD ["python", "server.py"]
