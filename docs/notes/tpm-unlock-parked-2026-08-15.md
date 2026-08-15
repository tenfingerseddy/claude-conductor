# TPM disk unlock on the inspiron: attempted, reverted, parked

2026-08-15, late evening. Kane asked for boot without the disk password. The attempt failed,
the box was recovered by its staged rescue entry, and the work is parked on purpose. This note
is the map for the next attempt.

## What happened

The plan was the standard systemd road: switch the initramfs to sd-encrypt, move the kernel
command line from `cryptdevice=` to `rd.luks.*`, enroll the TPM with `systemd-cryptenroll`.
The enroll worked: **LUKS slot 1 on /dev/nvme0n1p2 holds a TPM2 key, bound to PCR 7, and it
is still there, unused.**

The boot failed because Omarchy owns the initramfs recipe in `/etc/mkinitcpio.conf.d/`:
`omarchy_hooks.conf` sets HOOKS with busybox init and the legacy `encrypt` hook, and
`omarchy_resume.conf` appends `resume`. Drop-ins are sourced after `/etc/mkinitcpio.conf`, so
the edit there was overridden and the image kept the old unlock method while the command line
asked for the new one. Result: `ERROR: Failed to mount '/dev/mapper/root' on real root`,
emergency shell. The staged "Omarchy pre-TPM rescue" limine entry booted the box back.

## Why it is parked, not retried

- Omarchy has no sanctioned early-boot unlock beyond the passphrase. Its security helpers
  (`omarchy-setup-security-fido2`) configure PAM for sudo and polkit only.
- Switching to systemd init would fight the distro's own recipe on every update, and the
  `btrfs-overlayfs` hook that limine-snapper snapshot boots depend on is written for busybox
  init. Breaking snapshot boots breaks the rollback story.
- Arch's `clevis` package ships dracut modules only, no mkinitcpio hook.
- The remaining roads are an AUR hook or a hand-rolled `tpm2_unseal` runtime hook feeding
  `cryptkey=rootfs:`. Both are hand-carried boot code, and two boot surgeries in one night
  was the limit.

## State left on the box

- Boot config fully reverted: original `/etc/default/limine` and `/etc/mkinitcpio.conf`, image
  rebuilt from the original recipe, verified hook by hook. Backups at `*.pretpm`.
- The rescue entry and `/boot/EFI/Linux/omarchy_pretpm.efi` stay until the next clean normal
  boot proves the rebuilt image, then both can go. ESP has 1.5 G free, so no pressure.
- LUKS slot 1: the enrolled TPM2 key, harmless, ready if a future road can read it.
- `clevis` and `tpm2-tools` were installed and removed the same evening.

## The next attempt, if Kane still wants it

1. Choose the road first: AUR `mkinitcpio` clevis hook, or a small custom hook that unseals a
   key with `tpm2_unseal` into `/crypto_keyfile.bin` and lets the stock `encrypt` hook consume
   it via `cryptkey=rootfs:`. The custom road keeps Omarchy's recipe untouched except one
   inserted hook name.
2. Make every HOOKS change in a drop-in that sorts after `omarchy_hooks.conf`, never in the
   main file.
3. Before any reboot: extract the built UKI's initrd and verify the hook list and the init
   inside the image, not the config that claims to produce it.
4. Kane at the keyboard, rescue entry staged, one box at a time. The latitude only after the
   inspiron holds.
