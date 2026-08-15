FROM python:3.12-slim

RUN python -m pip install --no-cache-dir mitmproxy==12.2.3

COPY egress_filter.py /opt/maka-eval/egress_filter.py
COPY egress-proxy/entrypoint.sh /opt/maka-eval/entrypoint.sh

ENTRYPOINT ["/opt/maka-eval/entrypoint.sh"]
