# Squid forward proxy for the opencode agent (see ../README.md). Config comes
# from the ConfigMap; this image only adds the binary.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache squid
USER 1000
EXPOSE 3128
ENTRYPOINT ["/usr/sbin/squid", "-N", "-d1", "-f", "/etc/squid-cfg/squid.conf"]
