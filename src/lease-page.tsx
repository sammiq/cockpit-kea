/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * One lease, at #/<address> (see leasePath()). Laid out like Cockpit's
 * network interface page: breadcrumb, a details card, then the host
 * reservation it matches and the client's other leases. Read-only.
 */

import React from 'react';

import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core/dist/esm/components/Breadcrumb/index.js';
import { Button } from '@patternfly/react-core/dist/esm/components/Button/index.js';
import { Card, CardBody, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card/index.js';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm,
} from '@patternfly/react-core/dist/esm/components/DescriptionList/index.js';
import { Page, PageBreadcrumb, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Flex } from '@patternfly/react-core/dist/esm/layouts/Flex/index.js';
import { Gallery } from '@patternfly/react-core/dist/esm/layouts/Gallery/index.js';
import { ExclamationCircleIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import * as timeformat from 'timeformat';
import { EmptyStatePanel } from 'cockpit-components-empty-state.jsx';
import { ListingTable } from 'cockpit-components-table.jsx';
import type { ListingTableRowProps } from 'cockpit-components-table.jsx';

import { addressSortKey } from './kea';
import type { Reservation } from './kea';
import { CONFIG_FILES } from './model';
import type { DisplayLease, ModelState } from './model';
import {
    AccessDenied, findLease, formatAddress, formatDuration, formatTimeShort, Hostname, LeaseLink,
    leaseTypeText, logsUrl, None, stateLabel, stateText, Subtle, useNow,
} from './lease-utils';

const _ = cockpit.gettext;

type Item = [id: string, term: string, value: React.ReactNode];

const Details = ({ id, items }: { id: string, items: Item[] }) => (
    <DescriptionList id={id} className="pf-m-horizontal-on-sm">
        {items.filter(([, , value]) => value !== undefined && value !== null && value !== false && value !== "")
                .map(([field, term, value]) => (
                    <DescriptionListGroup key={field} data-field={field}>
                        <DescriptionListTerm>{term}</DescriptionListTerm>
                        <DescriptionListDescription>{value}</DescriptionListDescription>
                    </DescriptionListGroup>
                ))}
    </DescriptionList>
);

const Time = ({ t }: { t: number }) => (
    <>
        {timeformat.dateTime(t)} <Subtle>({timeformat.distanceToNow(t)})</Subtle>
    </>
);

/* A function, not a component: rows whose value is null are left out */
const code = (value: string | null) =>
    value ? <code className="kea-code">{value}</code> : null;

const LeaseDetails = ({ lease, now }: { lease: DisplayLease, now: number }) => (
    <Details
        id="kea-lease-details"
        items={[
            ["state", _("State"),
                <Flex key="state" spaceItems={{ default: 'spaceItemsSm' }}>
                    <span>{stateText(lease, now)}</span>
                    {stateLabel(lease, now)}
                </Flex>],
            ["hostname", _("Hostname"), <Hostname key="hostname" lease={lease} />],
            ["description", _("Description"), lease.description ?? <None />],
            ["mac", _("MAC address"), code(lease.hwaddr)],
            ["duid", _("DUID"), code(lease.duid)],
            ["client-id", _("Client ID"), code(lease.clientId)],
            ["start", lease.expire === null ? _("Assigned") : _("Lease start"), <Time key="start" t={lease.start} />],
            ["end", _("Lease end"), lease.expire === null ? _("Never") : <Time key="end" t={lease.expire} />],
            ["lifetime", _("Valid lifetime"), lease.expire === null ? _("Infinite") : formatDuration(lease.validLifetime)],
            ["subnet", _("Subnet ID"), lease.subnetId !== null && String(lease.subnetId)],
            ["context", _("User context"), lease.userContext &&
                <pre className="kea-code">{JSON.stringify(lease.userContext, null, 2)}</pre>],
        ]}
    />
);

const ReservationCard = ({ reservation }: { reservation: Reservation }) => (
    <Card isPlain id="kea-lease-reservation">
        <CardHeader>
            <CardTitle component="h2">{_("Host reservation")}</CardTitle>
        </CardHeader>
        <CardBody>
            <Details
                id="kea-reservation-details"
                items={[
                    ["hostname", _("Hostname"), reservation.hostname],
                    ["description", _("Description"), reservation.description],
                    ["mac", _("MAC address"), code(reservation.hwaddr)],
                    ["duid", _("DUID"), code(reservation.duid)],
                    ["client-id", _("Client ID"), code(reservation.clientId)],
                    ["addresses", _("Reserved addresses"), reservation.addresses.length > 0
                        ? <span className="kea-address">{reservation.addresses.join(", ")}</span>
                        : _("None (options or hostname only)")],
                    ["config", _("Configured in"), CONFIG_FILES[reservation.family]],
                ]}
            />
        </CardBody>
    </Card>
);

/* Leases of the same client: same MAC address or DUID */
function sameClient(a: DisplayLease, b: DisplayLease): boolean {
    return a.key !== b.key && (
        (a.hwaddr !== null && a.hwaddr === b.hwaddr) ||
        (a.duid !== null && a.duid === b.duid));
}

const OtherLeasesCard = ({ leases, now }: { leases: DisplayLease[], now: number }) => {
    const rows: ListingTableRowProps[] = [...leases]
            .sort((a, b) => addressSortKey(a).localeCompare(addressSortKey(b)))
            .map(l => ({
                props: { key: l.key, "data-row-id": l.key } as NonNullable<ListingTableRowProps["props"]>,
                columns: [
                    {
                        title: (
                            <Flex spaceItems={{ default: 'spaceItemsSm' }} rowGap={{ default: 'rowGapXs' }}>
                                <LeaseLink lease={l} />
                                {stateLabel(l, now)}
                            </Flex>
                        ),
                    },
                    { title: leaseTypeText(l) },
                    { title: <Hostname lease={l} /> },
                    { title: l.expire === null ? _("Never") : formatTimeShort(l.expire, now) },
                ],
            }));

    return (
        <Card isPlain id="kea-lease-others">
            <CardHeader>
                <CardTitle component="h2">{_("Other leases of this client")}</CardTitle>
            </CardHeader>
            <ListingTable
                aria-label={_("Other leases of this client")}
                variant="compact"
                columns={[
                    { title: _("IP address"), header: true },
                    { title: _("Type") },
                    { title: _("Hostname") },
                    { title: _("Lease end") },
                ]}
                rows={rows}
            />
        </Card>
    );
};

const LeaseBreadcrumb = ({ title }: { title: string }) => (
    <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
        <Breadcrumb>
            <BreadcrumbItem to="#/">{_("DHCP server")}</BreadcrumbItem>
            <BreadcrumbItem isActive>{title}</BreadcrumbItem>
        </Breadcrumb>
    </PageBreadcrumb>
);

export const LeasePage = ({ state, path }: { state: ModelState, path: string[] }) => {
    const now = useNow();
    const lease = findLease(state.leases, path);
    const title = path.length === 3 ? `${path[1]}/${path[2]}` : path[path.length - 1];

    let content: React.ReactNode;
    if (state.loading) {
        content = <EmptyStatePanel loading />;
    } else if (state.accessDenied) {
        content = <AccessDenied />;
    } else if (!lease) {
        content = (
            <EmptyStatePanel
                icon={ExclamationCircleIcon}
                title={cockpit.format(_("No lease for $0"), title)}
                paragraph={_("The lease may have expired and been removed by the server.")}
                action={_("Return to overview page")}
                actionVariant="link"
                onAction={() => cockpit.location.go("/")}
            />
        );
    } else {
        const others = state.leases.filter(l => sameClient(lease, l));
        // Kea writes the MAC address or DUID in its log messages about a client
        const logSearch = lease.hwaddr ?? lease.duid;

        content = (
            <Gallery hasGutter>
                <Card isPlain id="kea-lease">
                    <CardHeader
                        {...logSearch && {
                            actions: {
                                hasNoOffset: false,
                                actions: (
                                    <Button variant="secondary" onClick={() => cockpit.jump(logsUrl(logSearch), cockpit.transport.host)}>
                                        {_("View logs")}
                                    </Button>
                                ),
                            }
                        }}
                    >
                        <CardTitle component="h2" className="kea-lease-title">
                            <span id="kea-lease-address" className="kea-address">{formatAddress(lease)}</span>
                            <span id="kea-lease-type">{leaseTypeText(lease)}</span>
                        </CardTitle>
                    </CardHeader>
                    <CardBody>
                        <LeaseDetails lease={lease} now={now} />
                    </CardBody>
                </Card>
                {lease.reservation && <ReservationCard reservation={lease.reservation} />}
                {others.length > 0 && <OtherLeasesCard leases={others} now={now} />}
            </Gallery>
        );
    }

    return (
        <Page id="kea-lease-page" className="pf-m-no-sidebar">
            <LeaseBreadcrumb title={title} />
            <PageSection hasBodyWrapper={false}>
                {content}
            </PageSection>
        </Page>
    );
};
