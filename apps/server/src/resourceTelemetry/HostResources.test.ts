import { describe, expect, it } from "@effect/vitest";

import { darwinNetworkBytes, linuxNetworkBytes } from "./HostResources.ts";

const procNetDev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 23408871028 6782044    0    0    0     0          0         0 23408871028 6782044    0    0    0     0       0          0
enp3s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  wlo1: 85530775691 66378879    0    1    0     0          0         0 24756189235 24346859    0 3244    0     0       0          0
tailscale0: 8498985014 4456005    0    0    0     0          0         0 774082475 2320209    0    0    0     0       0          0
`;

describe("linuxNetworkBytes", () => {
  it("sums only the named interfaces", () => {
    expect(linuxNetworkBytes(procNetDev, new Set(["enp3s0", "wlo1"]))).toEqual({
      receivedBytes: 85530775691,
      sentBytes: 24756189235,
    });
  });

  it("omits the counters when no interface matches or a matching row is cut short", () => {
    expect(linuxNetworkBytes(procNetDev, new Set(["eth0"]))).toBeUndefined();
    expect(linuxNetworkBytes("  eth0: 100 2 0 0\n", new Set(["eth0"]))).toBeUndefined();
  });
});

const netstat = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       2337949     0 3072730592  2337949     0 3072730592     0
lo0        16384 127           127.0.0.1        2337949     - 3072730592  2337949     - 3072730592     -
en1        1500  <Link#8>    36:0a:f1:d2:5c:80        0     0          0        0     0          0     0
bridge0    1500  <Link#12>   36:0a:f1:d2:5c:80        0     0          0        0     0          0     0
ap1*       1500  <Link#10>   6e:83:cd:fc:b0:44        0     0          0        0     0          0     0
en0        1500  <Link#11>   4e:c3:b6:78:b6:e9 55449810     0 63297830230 37592764     0 30402620047     0
en0        1500  192.168.1     192.168.1.112   55449810     - 63297830230 37592764     - 30402620047     -
awdl0      1500  <Link#13>   26:9c:94:6e:e9:64       17     0       5067      256     0      27385     0
utun5      1280  <Link#21>                      4130221     0 1325126032 17127153     0 20217673496     0
`;

describe("darwinNetworkBytes", () => {
  it("sums the link row of each en interface", () => {
    expect(darwinNetworkBytes(netstat)).toEqual({
      receivedBytes: 63297830230,
      sentBytes: 30402620047,
    });
  });

  it("keeps counting an interface that went down", () => {
    const down =
      "en5*       1500  <Link#22>   4e:c3:b6:78:b6:ea      10     0       1000       20     0       2000     0\n";
    expect(darwinNetworkBytes(netstat + down)).toEqual({
      receivedBytes: 63297830230 + 1000,
      sentBytes: 30402620047 + 2000,
    });
  });

  it("omits the counters when the output has no en link rows", () => {
    expect(darwinNetworkBytes("")).toBeUndefined();
  });
});
