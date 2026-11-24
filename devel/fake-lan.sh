#!/bin/sh
# Fake LAN for the Kea dev container.
#
#   fake-lan.sh setup     bridge kea0 (192.168.50.1/24, fd00:50::1/64) with a
#                         veth per client, each client in its own netns; seeds
#                         a few leases for devices that aren't "on" right now
#   fake-lan.sh clients   run DHCPv4/DHCPv6 clients in the namespaces
#
# Clients (MAC, what it does):
#   c1 02:00:00:00:00:11  "laptop": DHCPv4 with hostname, DHCPv6 address
#   c2 02:00:00:00:00:12  "phone": DHCPv4 with hostname only
#   c3 02:00:00:00:00:13  reserved "nas": v4 + v6 reservations, prefix delegation
#   c4 random MAC         comes and goes: takes a lease, releases it, repeat
set -eu

CLIENTS="c1:02:00:00:00:00:11 c2:02:00:00:00:00:12 c3:02:00:00:00:00:13 c4:"

# udhcpc only reports the lease; give the client its address so that
# renewals (unicast to the server) work
cat > /run/udhcpc.script <<'EOF'
#!/bin/sh
case "$1" in
    bound|renew) ip addr replace "$ip/$mask" dev "$interface" ;;
    deconfig) ip -4 addr flush dev "$interface" ;;
esac
exit 0
EOF
chmod +x /run/udhcpc.script

# `ip netns exec` / `ip -n` remount /sys, which a rootless container forbids;
# nsenter only switches the network namespace.
in_ns() { ns=$1; shift; nsenter --net="/run/netns/$ns" "$@"; }

setup() {
    ip link add kea0 type bridge 2>/dev/null || true
    # No DAD: Kea's DHCPv6 server binds kea0's link-local address right away
    sysctl -qw net.ipv6.conf.kea0.accept_dad=0
    ip link set kea0 up
    ip addr replace 192.168.50.1/24 dev kea0
    ip addr replace fd00:50::1/64 dev kea0 nodad

    for c in $CLIENTS; do
        ns=${c%%:*}
        mac=${c#*:}
        ip netns add "$ns" 2>/dev/null || continue
        ip link add "$ns-br" type veth peer name eth0 netns "$ns"
        [ -n "$mac" ] && in_ns "$ns" ip link set eth0 address "$mac"
        in_ns "$ns" sysctl -qw net.ipv6.conf.eth0.accept_dad=0
        ip link set "$ns-br" master kea0 up
        in_ns "$ns" ip link set lo up
        in_ns "$ns" ip link set eth0 up
    done

    seed
}

# Leases for devices that aren't on the fake LAN, so the table has history:
# one still valid, one long expired (Kea reclaims it shortly after starting).
# Only on the first boot of a container, before Kea has written anything.
seed() {
    mkdir -p /var/lib/kea
    now=$(date +%s)

    if [ ! -e /var/lib/kea/kea-leases4.csv ]; then
        cat > /var/lib/kea/kea-leases4.csv <<EOF
address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,pool_id
192.168.50.20,02:00:00:00:00:21,,3600,$((now + 3000)),1,0,0,printer,0,,0
192.168.50.150,02:00:00:00:00:22,01:02:00:00:00:00:22,86400,$((now + 80000)),1,0,0,living-room-tv,0,{ "comment": "Seeded lease&#x2c with a comma" },0
192.168.50.151,02:00:00:00:00:23,,3600,$((now - 7200)),1,0,0,old-tablet,0,,0
EOF
    fi

    if [ ! -e /var/lib/kea/kea-leases6.csv ]; then
        cat > /var/lib/kea/kea-leases6.csv <<EOF
address,duid,valid_lifetime,expire,subnet_id,pref_lifetime,lease_type,iaid,prefix_len,fqdn_fwd,fqdn_rev,hostname,hwaddr,state,user_context,hwtype,hwaddr_source,pool_id
fd00:50::1f00,00:03:00:01:02:00:00:00:00:22,86400,$((now + 80000)),1,43200,0,1,128,0,0,living-room-tv,02:00:00:00:00:22,0,,1,2,0
fd00:50:100:ff00::,00:03:00:01:02:00:00:00:00:24,86400,$((now + 50000)),1,43200,2,1,64,0,0,,,0,,0,0,0
EOF
    fi

    chown -R _kea:_kea /var/lib/kea
}

clients() {
    for c in $CLIENTS; do
        ns=${c%%:*}
        case "$ns" in
            c1)
                in_ns c1 busybox udhcpc -f -i eth0 -s /run/udhcpc.script -x hostname:laptop &
                in_ns c1 busybox udhcpc6 -f -i eth0 -s /bin/true &
                ;;
            c2)
                in_ns c2 busybox udhcpc -f -i eth0 -s /run/udhcpc.script -x hostname:phone &
                ;;
            c3)
                in_ns c3 busybox udhcpc -f -i eth0 -s /run/udhcpc.script &
                in_ns c3 busybox udhcpc6 -f -d -i eth0 -s /bin/true &
                ;;
            c4)
                (
                    while true; do
                        in_ns c4 ip link set eth0 address "02:00:00:00:01:$(printf %02x $(($(date +%s) % 256)))"
                        in_ns c4 busybox udhcpc -f -R -i eth0 -s /run/udhcpc.script -x hostname:visitor &
                        sleep 60
                        kill $! 2>/dev/null || true   # releases the lease
                        in_ns c4 ip -4 addr flush dev eth0
                        sleep 30
                    done
                ) &
                ;;
        esac
    done
    wait
}

"$1"
