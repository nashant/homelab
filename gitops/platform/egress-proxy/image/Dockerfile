# Squid forward proxy for the opencode agent (see ../README.md). Config comes
# from the ConfigMap; this image only adds the binary.
FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
RUN apk add --no-cache squid
USER 1000
EXPOSE 3128
ENTRYPOINT ["/usr/sbin/squid", "-N", "-d1", "-f", "/etc/squid-cfg/squid.conf"]
