/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The leases table: DHCPv4 and DHCPv6 leases together, current ones by
 * default, expired/released/declined ones on request.
 */

import React from 'react';

import { Alert } from '@patternfly/react-core/dist/esm/components/Alert/index.js';
import { Card, CardBody, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card/index.js';
import { Label } from '@patternfly/react-core/dist/esm/components/Label/index.js';
import { SearchInput } from '@patternfly/react-core/dist/esm/components/SearchInput/index.js';
import { Switch } from '@patternfly/react-core/dist/esm/components/Switch/index.js';
import { Flex, FlexItem } from '@patternfly/react-core/dist/esm/layouts/Flex/index.js';
import { SortByDirection } from '@patternfly/react-table';

import cockpit from 'cockpit';
import * as timeformat from 'timeformat';
import { EmptyStatePanel } from 'cockpit-components-empty-state.jsx';
import { ListingTable } from 'cockpit-components-table.jsx';
import type { ListingTableRowProps } from 'cockpit-components-table.jsx';

import { addressSortKey, LEASE_TYPE_PD } from './kea';
import type { DisplayLease, ModelState } from './model';
import {
    AccessDenied, formatAddress, formatTimeShort, Hostname, isCurrent, LeaseLink, None, stateLabel, Subtle, useNow,
} from './lease-utils';

const _ = cockpit.gettext;

function matchesFilter(lease: DisplayLease, filter: string): boolean {
    if (!filter)
        return true;
    const needle = filter.toLowerCase();
    return [formatAddress(lease), lease.hwaddr, lease.hostname, lease.description, lease.duid, lease.clientId]
            .some(v => v?.toLowerCase().includes(needle));
}

function timeCell(t: number | null, now: number, never: string) {
    if (t === null)
        return { title: <Subtle>{never}</Subtle>, sortKey: "z" };
    return {
        title: <span title={timeformat.distanceToNow(t)}>{formatTimeShort(t, now)}</span>,
        // fixed width, so string comparison sorts by time
        sortKey: String(t).padStart(16, "0"),
    };
}

function leaseRow(lease: DisplayLease, now: number): ListingTableRowProps {
    return {
        props: { key: lease.key, "data-row-id": lease.key } as NonNullable<ListingTableRowProps["props"]>,
        columns: [
            {
                title: (
                    <Flex spaceItems={{ default: 'spaceItemsSm' }} rowGap={{ default: 'rowGapXs' }}>
                        <LeaseLink lease={lease} />
                        {lease.leaseType === LEASE_TYPE_PD && <Label isCompact color="blue">{_("Prefix")}</Label>}
                        {stateLabel(lease, now)}
                    </Flex>
                ),
                sortKey: addressSortKey(lease),
            },
            { title: lease.hwaddr ? <span className="kea-mac">{lease.hwaddr}</span> : <None />, sortKey: lease.hwaddr ?? "~" },
            { title: <Hostname lease={lease} />, sortKey: lease.hostname ?? "~" },
            { title: lease.description ?? <None />, sortKey: lease.description ?? "~" },
            timeCell(lease.start, now, _("Unknown")),
            timeCell(lease.expire, now, _("Never")),
        ],
    };
}

function familyAlerts(state: ModelState): React.ReactNode[] {
    const alerts: React.ReactNode[] = [];
    for (const info of [state.families[4], state.families[6]]) {
        if (info.unsupportedBackend) {
            alerts.push(
                <Alert
                    key={`backend${info.family}`} isInline variant="info"
                    title={cockpit.format(_("DHCPv$0 leases are stored in a $1 database"), info.family, info.unsupportedBackend)}
                >
                    {_("Only leases in Kea's memfile (CSV) lease files can be shown.")}
                </Alert>
            );
        }
        if (info.configError) {
            alerts.push(
                <Alert key={`config${info.family}`} isInline variant="warning" title={info.configError}>
                    {cockpit.format(_("Reading leases from $0; descriptions from host reservations are not shown."), info.leaseFile ?? "")}
                </Alert>
            );
        }
    }
    for (const error of state.errors)
        alerts.push(<Alert key={error} isInline variant="warning" title={error} />);
    return alerts;
}

/* The filter and "Show expired" live in the app, so they survive a visit to
 * a lease's page */
export interface LeasesView {
    filter: string;
    showAll: boolean;
}

export const LeasesCard = ({ state, view, setView }: {
    state: ModelState,
    view: LeasesView,
    setView: (view: LeasesView) => void,
}) => {
    const now = useNow();
    const { filter, showAll } = view;
    const setFilter = (filter: string) => setView({ ...view, filter });
    const setShowAll = (showAll: boolean) => setView({ ...view, showAll });

    const current = state.leases.filter(l => isCurrent(l, now));
    const shown = (showAll ? state.leases : current).filter(l => matchesFilter(l, filter));
    const otherCount = state.leases.length - current.length;

    const columns = [
        { title: _("IP address"), sortable: true, header: true },
        { title: _("MAC address"), sortable: true },
        { title: _("Hostname"), sortable: true },
        { title: _("Description"), sortable: true },
        { title: _("Lease start"), sortable: true },
        { title: _("Lease end"), sortable: true },
    ];

    let body: React.ReactNode;
    if (state.loading) {
        body = <EmptyStatePanel loading />;
    } else if (state.accessDenied) {
        body = <AccessDenied />;
    } else {
        const noFiles = !state.families[4].leaseFileFound && !state.families[6].leaseFileFound;
        body = (
            <ListingTable
                aria-label={_("DHCP leases")}
                variant="compact"
                columns={columns}
                rows={shown.map(l => leaseRow(l, now))}
                sortBy={{ index: 0, direction: SortByDirection.asc }}
                emptyCaption={filter
                    ? _("No leases match the filter")
                    : noFiles ? _("No lease files found") : _("No current leases")}
                emptyCaptionDetail={!filter && noFiles
                    ? cockpit.format(_("Looked for $0"), [state.families[4].leaseFile, state.families[6].leaseFile].filter(Boolean).join(", "))
                    : undefined}
                isEmptyStateInTable={!!filter}
            />
        );
    }

    const ready = !state.loading && !state.accessDenied;
    const alerts = ready ? familyAlerts(state) : [];

    return (
        <Card isPlain id="kea-leases">
            <CardHeader
                {...ready && {
                    actions: {
                        hasNoOffset: true,
                        actions: (
                            <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }} flexWrap={{ default: 'nowrap' }}>
                                <Switch
                                    id="kea-leases-show-all"
                                    className="kea-nowrap"
                                    label={cockpit.format(_("Show expired ($0)"), otherCount)}
                                    isChecked={showAll}
                                    onChange={(_ev, checked) => setShowAll(checked)}
                                />
                                <SearchInput
                                    id="kea-leases-filter"
                                    aria-label={_("Filter leases")}
                                    placeholder={_("Filter")}
                                    value={filter}
                                    onChange={(_ev, value) => setFilter(value)}
                                    onClear={() => setFilter("")}
                                />
                            </Flex>
                        ),
                    }
                }}
            >
                <Flex alignItems={{ default: 'alignItemsBaseline' }} spaceItems={{ default: 'spaceItemsSm' }}>
                    <CardTitle component="h2">{_("Leases")}</CardTitle>
                    {ready && (
                        <FlexItem>
                            <Subtle>
                                {cockpit.format(cockpit.ngettext("$0 current", "$0 current", current.length), current.length)}
                            </Subtle>
                        </FlexItem>
                    )}
                </Flex>
            </CardHeader>
            {alerts.length > 0 && <CardBody className="kea-alerts">{alerts}</CardBody>}
            {body}
        </Card>
    );
};
