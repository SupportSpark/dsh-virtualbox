# dsh-virtualbox

给 DSH（DeepSeek Harness）用的 VirtualBox 插件：**用配置描述一台 Linux 虚拟机，一条命令把它建好、启动、等到 SSH 可用，然后直接在里面跑测试。**

底层全部走本机的 `VBoxManage`，不需要 qemu-img、不需要 WSL、不需要 Guest Additions，也没有任何 npm 运行时依赖。

```
vbox_templates   →  看有哪些系统
vbox_create      →  建一台并等它可登录
vbox_ssh         →  在 guest 里执行命令
vbox_snapshot    →  回到干净状态
vbox_apply       →  按配置文件把整套环境拉起来
```

---

## 它解决什么问题

测试一个 Linux 专用的东西（编译、服务、权限、内核行为、某个只在 Debian 12 上复现的 bug）时，临时装一台机器是最大的摩擦。这个插件把那一步变成一次工具调用：

- **镜像**：直接用各发行版官方 cloud image（Debian / Ubuntu / Rocky / AlmaLinux / Fedora / openSUSE / Alpine），镜像矩阵参考 [bin456789/reinstall](https://github.com/bin456789/reinstall) 的做法；下载后缓存在本地，第二次用同一模板不再联网。
- **无人值守**：插件自己生成 cloud-init 的 NoCloud seed ISO（卷标 `cidata`，**带 Joliet**，保证 guest 里看见的就是 `user-data` / `meta-data` 这两个名字），创建登录用户、装入你的 SSH 公钥、开免密 sudo、按需装包、跑 `runcmd`。
- **网络**：NAT + 回环端口转发（`127.0.0.1:<port>` → guest `22`），不需要管理员权限、不需要改宿主机网络、不暴露到局域网。
- **模板**：`examples/boxes.json` 里一台机器就是一段配置；改 `template` / `cpus` / `memoryMB` / `diskGB` 就是另一台机器，`vbox_apply` 幂等地把现状收敛到配置。

---

## 前置条件

| 依赖 | 说明 |
|---|---|
| VirtualBox 7.x | 只需要 `VBoxManage`。插件会自动在注册表默认路径、`VBOX_MSI_INSTALL_PATH`、常见安装盘符、`PATH` 里找 |
| Node.js ≥ 20 | 由 DSH 自身提供 |
| OpenSSH client（`ssh` / `ssh-keygen`） | Windows 10+ 自带；Git for Windows 的也可以 |
| `tar` | 解 `.tar.xz` 镜像用（Windows 10+ 自带 bsdtar） |

镜像一律是 **raw / tar.xz / 未压缩 qcow2 / vmdk**，插件内部完成到 VDI 的转换。qcow2 的**压缩簇**（Debian 官方 `.qcow2` 就是这样打包的）不在支持范围，对应模板已经换成同发行版的 `.tar.xz` 或 `.raw`——这样既不需要 qemu-img，也不会静默产出坏盘。

---

## 安装

```bash
# 从本地目录（开发时）
dsh plugin add link:/absolute/path/to/dsh-virtualbox

# 从 GitHub
dsh plugin add github:SupportSpark/dsh-virtualbox
```

装好即生效（`cordis.patch.yml` 里已经声明了插件条目）。也可以直接在 Web 侧栏的 **Plugins** 页面里添加。

> **桌面版用户注意**：Electron 桌面端独占管理 `desktop` profile，CLI 会拒绝直接操作它（`profile "desktop" is managed exclusively by the Electron application`）。请在 **Plugins** 页面安装，或重启桌面端让其自行同步。独立 profile 可用 CLI 安装，已验证 `--dump-config` 能把插件行正确组合进 profile。

配置是可选的，默认值在 `lib/index.js` 的 `DEFAULTS`：

```yaml
- id: dsh-virtualbox
  name: dsh-virtualbox
  config:
    homeDir: E:\dsh-vm          # 所有工作目录的根（默认 ~/dsh-virtualbox）
    defaultTemplate: debian-12  # vbox_create 不传 template 时用它
    defaultCpus: 2
    mirror: direct              # direct | ghproxy | npmmirror-cloud
    startType: headless         # headless | gui
    bootTimeoutMs: 600000       # 等 SSH 的上限
    boxFile: E:\dsh-vm\boxes.json
```

`homeDir` 之下会生成 `vms/`（虚拟机与磁盘）、`cache/`（镜像与 known_hosts）、`state/`（每台 VM 的记录）、`keys/`（SSH 密钥）。

---

## 工具

| 工具 | 用途 |
|---|---|
| `vbox_status` | 引擎版本、宿主机 CPU、VM 清单、各自 SSH 端口。新会话先调它 |
| `vbox_templates` | 镜像目录：格式、默认用户、固件、最小内存/磁盘、是否已缓存 |
| `vbox_fetch_image` | 只下镜像（预热缓存），不建 VM |
| `vbox_create` | 建 VM + 云镜像转换 + seed ISO + NAT 转发 + 基线快照 + 等到 SSH 可用 |
| `vbox_list` / `vbox_info` | 清单 / 单机详情（含 NAT 转发、guest IP） |
| `vbox_start` / `vbox_stop` / `vbox_destroy` | 开关机、删除 |
| `vbox_wait` | 等 SSH（并等 cloud-init 结束） |
| `vbox_ssh` | 在 guest 里执行命令，返回退出码 + stdout/stderr |
| `vbox_snapshot` | `list` / `take` / `restore` / `delete` |
| `vbox_reset` | 回到 `clean` 快照并重启（测试轮次之间用） |
| `vbox_clone` | 克隆（可从快照克隆，自动换 MAC 和 SSH 端口） |
| `vbox_apply` | 按 boxes 配置文件幂等收敛整套环境 |
| `vbox_console` | 截控制台 PNG + 串口日志尾部（机器起不来时看这个） |
| `vbox_keys` | 往控制台敲字符（驱动文本安装器） |
| `vbox_network` | 端口转发、host-only 网卡、NAT 网络（`action` = `list_nat_rules` / `add_nat_rule` / `list_hostonlyifs` …） |
| `vbox_storage` | 磁盘：列全部介质、看单个详情、创建、挂载、卸载、扩容、克隆、压缩 |
| `vbox_export` | 导出成 OVA/OVF，或导入一个 |
| `vbox_metrics` | 宿主机与单机的 CPU/内存计数器（`list` / `sample` / `query` / `host`） |
| `vbox_help` | 全部 `vbox_*` 工具清单 + 常用配方 |

后五个是 **portmanteau 工具**：一个域一个工具，用 `action` 区分具体操作。已经懂
VirtualBox 的模型需要的是"能做哪些操作"，而不是在工具列表里再多几十个名字，所以
同类动作用同一个 schema。生命周期类工具保持独立 —— 那些是按意图取的（"把机器启起来"），
不是按分类找的。

---

## 最小用法

```
vbox_create { "template": "debian-12", "name": "lab1", "packages": ["build-essential"] }
→ lab1 ready · ssh -p 2222 -i .../keys/id_ed25519 dev@127.0.0.1

vbox_ssh { "name": "lab1", "command": "uname -a && gcc --version | head -1" }

vbox_reset { "name": "lab1" }        // 回到 clean，扔掉这段时间的改动
vbox_destroy { "name": "lab1" }
```

## 模板化用法（推荐）

编辑 `examples/boxes.json`：

```json
{
  "defaults": {
    "template": "debian-12",
    "cpus": 2, "memoryMB": 2048, "diskGB": 12, "user": "dev",
    "snapshot": "clean"
  },
  "boxes": {
    "lab-debian": { "packages": ["build-essential", "gdb"] },
    "lab-ubuntu": { "template": "ubuntu-24.04", "memoryMB": 4096 },
    "lab-alpine": { "template": "alpine-3.21", "cpus": 1, "memoryMB": 512 }
  }
}
```

然后：

```
vbox_apply {}                       // 全部拉起（缺的建，停的启，运行中的不动）
vbox_apply { "only": ["lab-alpine"] }   // 只动一台
vbox_apply { "dryRun": true }           // 先看会做什么
```

文件里允许 `//` 和 `/* */` 注释（扫描时跳过字符串字面量，`https://` 不会被误认成注释）。

---

## 镜像目录

| id | 发行版 | 载荷 | 默认用户 |
|---|---|---|---|
| `debian-13` / `debian-12` / `debian-11` | Debian | tar.xz（内含 `disk.raw`） | `debian` |
| `ubuntu-24.04` / `ubuntu-22.04` | Ubuntu LTS | qcow2（`.img` 后缀） | `ubuntu` |
| `rocky-9` / `alma-9` | RHEL 系 | qcow2 | `rocky` / `almalinux` |
| `fedora-42` | Fedora | qcow2 | `fedora` |
| `opensuse-leap-15.6` | openSUSE | qcow2 | `opensuse` |
| `alpine-3.21` | Alpine | qcow2 | `alpine` |
| `alpine-virt` | Alpine live ISO | iso | `root` |
| `reinstall-iso` | bin456789/reinstall 引导盘 | iso | `root` |

**为什么 Debian 用 generic 而不是 genericcloud**：Debian 的 *cloud* 镜像把 initramfs 裁剪成只带 virtio 驱动，挂在 VirtualBox 的 SATA/AHCI 上时内核在 initramfs 里就报 `ALERT! PARTUUID=... does not exist`，永远等不到根分区；*generic* 镜像是完整 initramfs（含 `ahci`），配合 `paravirtprovider=none` 可稳定启动（实测 40 秒内 cloud-init 完成并可 SSH）。同理，cloud 镜像里若 initramfs 只带 virtio，就需要换成该发行版的 generic/variant 镜像。

点版本号会变的模板（Alpine、Fedora）在 `notes` 里写了这一点，需要时用 `url`, 直接覆盖成固定版本。`mirror` 支持 `ghproxy`（GitHub 加速）与 `npmmirror-cloud`（NJTU 镜像）。

关于 `reinstall-iso`：上游仓库**没有发布可引导 ISO**（releases 为空），这条模板指向 `releases/latest/download/reinstall.iso`，取不到时会明确报错。它的真实用法是「已经有一台 Linux/Windows 的机器上跑脚本重装」，空 VM 场景请用云镜像模板。

---

## 工作原理

1. **取镜像** → `cache/<template>--<file>`，带 `.part` 原子落盘与可选 SHA-256 校验；网络失败会自动回退到模板的 `altUrl`。
2. **落盘**（按 magic bytes 判断真实格式，不看扩展名）：
   - `raw` → `VBoxManage convertfromraw`
   - `qcow2`（未压缩）→ 插件内实现的 L1/L2 走表转 raw，再转 VDI
   - `tar.xz` / `xz` → `tar -xf` 取出 `disk.raw`
   - `vmdk` → `clonemedium`
3. **扩容** → `modifymedium --resize`，guest 里由 cloud-init 的 `growpart` 撑大文件系统。
4. **seed** → 生成 `meta-data` / `user-data`，打成 ISO9660 + Joliet 双目录树的 `cidata` 镜像。
5. **组机** → `createvm` + `modifyvm`（BIOS 或 EFI、`ioapic`、NAT + `natpf1`、vmsvga、串口日志落文件）+ SATA/AHCI 挂盘与光驱。
6. **基线快照**（默认名 `clean`）在首次开机之前拍，所以任何一次 `vbox_reset` 都是真正的出厂状态。
7. **就绪判定** → 先探 `127.0.0.1:<port>`，再真的 SSH 登录一次，最后等 `cloud-init status` 变成 `done`。

---

## 排错

| 现象 | 处理 |
|---|---|
| `vbox_wait` 超时 | `vbox_console` 看截图和 `vms/<name>/serial.log` 尾部；常见是镜像固件不匹配（试 `firmware: "efi"`）或 cloud-init 没读到 seed |
| VM 明显慢、guest 时钟跑飞 | 先 `vbox_status` 看 `execution engine` 行：`NEM/WHP` 表示 CPU 虚拟化扩展被别的 hypervisor 占着。**关掉"启用或关闭 Windows 功能"里的 Hyper-V 并不够** —— VBS/内存完整性（HVCI）、Credential Guard、KeyGuard 都会让 hypervisor 继续运行；`vbox_status` 会同时报出 `VBS configured` / `HVCI configured` / `hvservice` 状态 |
| 开着内存完整性还能用吗 | **能**。本机实测两种状态：内存完整性开启时 e2e 28/28、建机 40 秒；关闭后 30/30、41 秒，差别在噪声内。代价只有嵌套虚拟化（VM 里跑 VM）和可能略慢的 CPU 密集型负载。`paravirtprovider` 已默认 `none`，时钟两种模式下都正常 |
| 想让 VirtualBox 用原生 AMD-V / VT-x | 需要同时拆掉整条链：关闭内存完整性、`KeyGuard`、并把 `vsmlaunchtype` 与 `hypervisorlaunchtype` 一起设为 off，然后**重启**（hypervisor 无法运行时卸载）。注意 **Windows 11 24H2/26H2 在支持 VBS 的硬件上可能坚持保留 hypervisor**，本机实测四个开关全关、两次重启后 `HypervisorPresent` 仍为 True —— 这时建议直接用 NEM（功能无损），而不是继续折腾 |
| `cloud-init` 状态 `error` | `vbox_ssh` 读 `/var/log/cloud-init-output.log`；插件在 wait 失败时也会带回来最后 40 行。注意 cloud-init 的 `config` 阶段一旦失败，后面的 `runcmd` 不会执行 |
| SSH 连上但命令报 `Permission denied` | 确认用的是插件生成的 key（`keys/id_ed25519`），`vbox_info` 里有端口和用户 |
| `Permission denied (publickey)` + `UNPROTECTED PRIVATE KEY FILE` | Windows 上私钥继承了父目录 ACL（含 `Authenticated Users`），OpenSSH 会拒绝使用。插件在每次登录前都会用 `icacls /inheritance:r` 收紧到当前用户；手工拷来的 key 也建议自己跑一遍 |
| `packages:` / `runcmd` 很慢或没生效 | 默认 apt 源（`deb.debian.org`）在某些线路上只有几十 kB/s，`apt-get update` 会跑几分钟并撞穿等待上限。插件默认把 guest 的 apt 源换成区域镜像（`aptMirror: "auto"`，实测 12.6 MB/s）；要保留原源设 `aptMirror: false` |
| VirtualBox 报 `VERR_NEM_VM_CREATE_FAILED` / 起不来 | 宿主机开了 Hyper-V 时由 WHP 接管，需要启用「Windows 虚拟机监控程序平台」；本机已验证可启动 |
| 磁盘只有 3 GiB | 忘了 `diskGB`；`modifymedium --resize` 只在创建时执行，已有 VM 请重建 |
| 下载卡住 | 换 `mirror: "npmmirror-cloud"` 或 `ghproxy`，或先 `vbox_fetch_image` 单独预热 |

---

## 嵌套虚拟化（VM 里跑 VM）

**当前状态：不可用。** 本机实测（内存完整性开启、hypervisor 在跑）：

| 检查 | 结果 |
|---|---|
| `VBoxManage list hostinfo` | `Processor supports nested HW virtualization: no` |
| guest 内 `/proc/cpuinfo` | **没有 `svm` / `vmx` 标志** |
| guest 内 `/dev/kvm` | 不存在 |
| guest 内 `modprobe kvm_amd` | `Operation not supported` |

原因：Windows 的 hypervisor 把 AMD-V/SVM 从 CPUID 里抹掉了，VirtualBox 自己都拿不到，更没法透给 guest。

VirtualBox 侧有开关 `--nested-hw-virt on`，插件对应参数是 `vbox_create { "nestedHwVirt": true }`。但它**只在 VirtualBox 真正持有 CPU 虚拟化扩展时才有意义** —— 也就是 hypervisor 必须让开（见上文"想让 VirtualBox 用原生 AMD-V"那一行，且 Windows 11 26H2 可能拒绝）。

### 关于微软那篇「在虚拟机中运行 Hyper-V」的文档

`Set-VMProcessor -VMName X -ExposeVirtualizationExtensions $true` 是 **Hyper-V 专属**命令，作用于 Hyper-V 主机上的 Hyper-V 虚拟机，前提是：

- 主机装好 Hyper-V 角色（Windows Server 2016+ / Win10+；AMD 平台要求 Win11+）
- 虚拟机配置版本 ≥ 8.0（Intel）/ ≥ 9.3（AMD）

**不能套用到 VirtualBox**：本机 `Microsoft-Hyper-V-All` 是 Disabled，Hyper-V PowerShell 模块根本不存在（`Get-VMProcessor` 找不到），这条命令在这里无从执行；而且它做的是"把扩展透给 Hyper-V 的 guest"，与 VirtualBox 的 NEM 路径无关。

如果你确实需要嵌套，两条路：

1. **换后端**：装 Hyper-V 角色，用 Hyper-V 建 VM，再按那篇文档开 `ExposeVirtualizationExtensions`（这条路能同时保留内存完整性）
2. **留 VirtualBox**：必须让 hypervisor 让出 AMD-V，即彻底关闭 VBS 整条链并重启，然后再 `nestedHwVirt: true`

## 磁盘空间

数据盘现在以 `--discard on --nonrotational on` 挂载：guest 的 TRIM 能传到 VDI，
被删除的块会真正还给宿主机，而不是一直占着。少了这一对参数，20 GiB 的盘即使
guest 里只有几个 G 数据，也会一路涨到接近标称容量，而 `modifymedium --compact`
没有任何空洞可回收。

0.2.1 之前创建的 VM 仍是 `discard` 关闭状态。关机后原地修正：

```bash
VBoxManage storageattach <vm> --storagectl SATA --port 0 --device 0 \
  --type hdd --medium "<当前磁盘文件>" --discard on --nonrotational on
```

然后在 guest 里开启一次定时器：`systemctl enable --now fstrim.timer`。
已经涨上去的部分用 `vbox_storage action=compact_disk` 回收，但**仍带快照的盘
必须先合并快照** —— 而合并会删掉那个快照，`vbox_reset` 就失去这个还原点。

## 已知边界

- **没有 Guest Additions**：共享文件夹、拖拽、剪贴板都不可用；文件进出请走 `vbox_ssh` / `scp`。
- **磁盘控制器固定 SATA/AHCI**：`VirtIO` 控制器在实测的 VirtualBox 7.2.22 上被拒绝（`Invalid controller type 11`），所以无法用 virtio-scsi 迁就裁剪过的 initramfs；换镜像比换控制器可靠。
- **压缩 qcow2 不支持**：会给出可操作的错误提示，而不是产出坏盘。
- **`paravirtprovider` 默认 `none`**：宿主机开着 Hyper-V 时 VirtualBox 走 NEM/WHP，`kvm-clock` 会让 guest 时钟快约 8 倍（实测 70 秒墙钟报出 578 秒 uptime），足以打乱 cloud-init、TLS 与 apt；关掉半虚拟化后时钟与宿主机一致（50 秒偏差 1 秒）。需要时可 `paravirt: "kvm"` 覆盖。
- **ISO 类模板需要驱动控制台**：`vbox_console` + `vbox_keys` 能敲字，但没有做安装器问答的自动解析。
- **单用户/低并发定位**：与多数本地桥接插件一样，状态与端口分配以单实例使用为前提。

## 开发

```bash
node scripts/selftest.mjs offline   # 格式写入器、目录、工具注册、只读工具（约 2 秒，不改宿主机）
node scripts/selftest.mjs e2e       # 真建一台 Debian、SSH 进去验证、快照、重启、删除
```

`e2e` 会在 `DSH_VBOX_HOME`（默认 `E:\VMs\dsh-virtualbox`，无 E: 则用临时目录）下工作，并把镜像缓存留着复用。

## 许可

MIT
