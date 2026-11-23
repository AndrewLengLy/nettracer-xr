/**
 * Lab mode's sample network: 3 PCs, 1 switch, 1 router, 1 server.
 * The router runs NAT, so a ping to the server shows a private address being
 * rewritten to a public one.
 */
import { M24 } from './net-core/engine.js';
import type { Device, Topology } from './net-core/types.js';

const host = (o: Partial<Device> & { id: string; name: string }): Device => ({
  type: 'laptop', role: 'client', mask: M24, gw: '192.168.1.1', dns: '203.0.113.10', vlan: 1, power: true, arpStatic: {}, uplink: 'sw1', ...o,
});

export function labTopology(): Topology {
  return {
    vlans: false, hsrp: false, tls: false,
    devices: {
      pcA: host({ id: 'pcA', name: 'PC-A', label: 'Workstation', ip: '192.168.1.10', mac: '3c:22:fb:1a:00:10' }),
      pcB: host({ id: 'pcB', name: 'PC-B', label: 'Workstation', ip: '192.168.1.20', mac: '3c:22:fb:1a:00:20' }),
      pcC: host({ id: 'pcC', name: 'PC-C', label: 'Workstation', ip: '192.168.1.30', mac: '3c:22:fb:1a:00:30' }),
      sw1: { id: 'sw1', type: 'switch', name: 'SW1', label: 'Switch', power: true, macStatic: {} },
      r1: {
        id: 'r1', type: 'router', name: 'R1', label: 'Router with NAT', power: true, priority: 100, arpStatic: {},
        ifaces: [
          { name: 'Gi0/0', mac: '00:1e:7a:c1:00:01', peer: 'sw1', vlan: 1, addrs: [{ ip: '192.168.1.1', mask: M24 }], hsrp: [] },
          { name: 'Gi0/1', mac: '00:1e:7a:c1:00:02', peer: 'srv', vlan: 1, addrs: [{ ip: '203.0.113.1', mask: M24 }], hsrp: [] },
        ],
        routes: [
          { net: '192.168.1.0', mask: M24, iface: 'Gi0/0', via: '', type: 'C' },
          { net: '203.0.113.0', mask: M24, iface: 'Gi0/1', via: '', type: 'C' },
        ],
        nat: { inside: 'Gi0/0', outside: 'Gi0/1', publicIp: '203.0.113.1' },
      },
      srv: host({
        id: 'srv', type: 'server', role: 'web', name: 'SRV', label: 'Web server', ip: '203.0.113.10', gw: '203.0.113.1',
        mac: '52:54:00:cb:00:0a', uplink: 'r1', records: {},
      }),
    },
  };
}

/** Tabletop positions in meters on the platform surface: x right, z toward the user. */
export const LAB_LAYOUT: Record<string, [number, number]> = {
  pcA: [-0.5, 0.16],
  pcB: [-0.28, 0.2],
  pcC: [-0.06, 0.22],
  sw1: [-0.26, -0.14],
  r1: [0.12, -0.12],
  srv: [0.46, -0.04],
};

/** Platform size in meters and its surface height. */
export const TABLE = { width: 1.3, depth: 0.7, height: 0.74 };
