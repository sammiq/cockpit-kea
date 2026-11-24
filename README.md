# cockpit-kea

A [Cockpit](https://cockpit-project.org/) page for hosts running the
[ISC Kea](https://www.isc.org/kea/) DHCP server. It shows:

* **Leases**: DHCPv4 and DHCPv6 leases in one table, with IP address (or
  delegated prefix), MAC address, hostname, description, lease start and
  lease end. Sortable and filterable. Current leases are shown by default.
  "Show expired" adds expired, reclaimed, released and declined ones.
* **A page per lease**: click an address to open `#/<address>`
  (`#/prefix/<prefix>/<length>` for a delegated prefix), with a breadcrumb
  back. It shows the lease's state, hostname, description, MAC address,
  DUID or client ID, start and end times, lifetime, subnet and user context.
  It also shows the host reservation it matches and the client's other
  leases, e.g. a host's DHCPv4 lease, DHCPv6 lease and delegated prefix
  together. "View logs" opens the Logs page searching for the client's MAC
  address or DUID.
* **Kea logs**: the latest journal entries of the Kea services, with a
  "View all logs" button that opens Cockpit's Logs page filtered to them.

It is **read-only**. It appears in the menu as "DHCP server" on hosts with
`/etc/kea`.

## How it works

| What | Source |
|------|--------|
| Leases | Kea's memfile lease files: `<file>.2`, `<file>.1` and `<file>`, replayed in that order as Kea does on startup. The last row for an address wins, and `valid_lifetime` 0 means deleted. The files are watched, so the table updates as Kea writes |
| Lease file location | `lease-database.name` in `/etc/kea/kea-dhcp4.conf` / `kea-dhcp6.conf`, defaulting to `/var/lib/kea/kea-leases4.csv` / `kea-leases6.csv` |
| Description | The lease's user context (`comment` or `description`), otherwise the matching host reservation's `comment` or `user-context` `description`/`comment`. A reservation matches by IP address, then by MAC address, DUID or client ID |
| Hostname | The lease's hostname. If the client sent none, the reservation's hostname or the hostname of another lease with the same MAC address is shown greyed out (DHCPv6 clients often send no name) |
| Lease start | `expire - valid_lifetime`. That's the last renewal, which is what Kea records |
| Logs | journal of `kea-dhcp4-server`, `kea-dhcp6-server`, `kea-dhcp-ddns-server` and `kea-ctrl-agent` (Debian's unit names), plus the `isc-kea-*` units of ISC's own packages |

On Debian, `/etc/kea` and `/var/lib/kea` are only readable by `_kea` (mode
0750), so the leases need **administrative access**. With limited access
the page shows a button to turn it on. The logs only need journal access
(the `adm` group).

Limits:

* Only the memfile backend. With a MySQL/PostgreSQL lease database the page
  says so and shows no leases.
* Reservations come from the config files only, not from a hosts database
  (`host_cmds`). Files pulled in with `<?include?>` are not read.

Code: `src/kea.ts` (CSV and config parsing, no Cockpit dependencies),
`src/model.ts` (file watching), `src/app.tsx` (routing, overview and logs),
`src/leases-card.tsx` (the leases table), `src/lease-page.tsx` (one lease)
and `src/lease-utils.tsx` (shared formatting, page paths, log units). Developed against Debian Trixie (Kea 2.6.3,
Cockpit 337).

# Development

Dependencies (Fedora: `sudo dnf install gettext nodejs npm make podman`):

    make                   # fetch pkg/lib from Cockpit, npm install, build dist/

## Dev container (recommended)

A rootless podman container running Debian Trixie with Kea DHCPv4/DHCPv6
and Cockpit:

    make devel-container   # build image on first run, then start it
    make watch             # rebuild dist/ on every change

Open <http://127.0.0.1:9092/kea> and log in as `admin` / `admin`. Click
"Limited access" (top right) and enter the password to see the leases.
After each rebuild, reload the page. The container serves your checkout's
`dist/` directly. (The port is 9092, so it can run alongside the
cockpit-networkd container on 9091.)

The container has a fake LAN, bridge `kea0` (192.168.50.0/24 and
fd00:50::/64), set up by `devel/fake-lan.sh`. Kea serves it with the configs
in `devel/kea/`, using 2-minute lifetimes so renewals show up while you
watch. Clients live in their own network namespaces and run busybox
`udhcpc`/`udhcpc6`:

| Client | MAC | What it does |
|--------|-----|--------------|
| c1 | 02:00:00:00:00:11 | "laptop": DHCPv4 with hostname, DHCPv6 address without one |
| c2 | 02:00:00:00:00:12 | "phone": DHCPv4 only |
| c3 | 02:00:00:00:00:13 | reserved "nas" with a description: v4 and v6 reservations, plus a delegated prefix |
| c4 | changes | "visitor": takes a lease for a minute, releases it, comes back with a new MAC |

On first boot, it also seeds leases for devices that aren't on the LAN: a
printer (reservation with a description), a TV (user context comment with
an escaped comma, plus a v6 lease), and an orphaned delegated prefix.

Other targets: `make devel-shell` (root shell in the container), `make
devel-stop`, `make devel-image` (rebuild after changing `devel/`).
`DEVEL_PORT=…` changes the port. `devel/bin/devel-container logs` follows
the Kea and client journals.

The container needs `--privileged`. It is rootless, so this is limited to
your own user account's privileges. systemd needs it, and so does creating
the bridge and namespaces.

## Against a real server

`RSYNC_DEVEL=server make watch` copies each build to `~/.local/share/cockpit/`
on `server` over ssh. Remove it there with `rm -r ~/.local/share/cockpit/kea`.

## Installing

### Debian / Ubuntu package

    make deb               # -> cockpit-kea_<version>_all.deb
    scp cockpit-kea_*_all.deb server:
    ssh server sudo apt install ./cockpit-kea_<version>_all.deb

It installs to `/usr/share/cockpit/kea`, depends on `cockpit-bridge`, and
recommends `kea-dhcp4-server | kea-dhcp6-server`. Remove it with `apt remove
cockpit-kea`.

* The target always does a fresh production (minified, gzipped) build, so
  `dist/` is left in production mode afterwards. Run `make` or `make watch`
  before going back to the dev container.
* The version comes from `git describe`, which gives `1` until there's a
  tag. Tag releases (e.g. `git tag 0.1`) so upgrades get increasing versions.
* `Maintainer` is filled in from your `git config user.name`/`user.email`
  (override with `DEB_MAINTAINER=…`).
* It uses `dpkg-deb` if installed, otherwise runs it in a `debian:trixie`
  container with podman.

Adapted from [cockpit-sensors](https://github.com/ocristopfer/cockpit-sensors)'
Makefile. It's a plain `dpkg-deb` build, not a full `debian/` source package,
which is fine for installing on your own machines.

### Other ways

`make install` installs to `/usr/local/share/cockpit/kea`
(`PREFIX=/usr` for `/usr/share`). `make rpm` and `packaging/arch` come from
the starter kit and are untested.

## Checks

    npm run eslint         # or eslint:fix
    npm run stylelint
    test/common/typecheck

`make codecheck` runs all of these. The VM-based integration tests from the
starter kit (`make check`, `test/check-application`) need `/dev/kvm` and a
Cockpit test image with Kea. They have not been run yet.

# Based on

[cockpit-project/starter-kit](https://github.com/cockpit-project/starter-kit).
`pkg/lib` and `test/common` are fetched from Cockpit at the commit pinned in
the `Makefile`.
