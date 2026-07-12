#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot fallback path. The PRIMARY boot bringup is the Evogent APK's BootReceiver firing
# a RUN_COMMAND intent (no addon required). This script only runs if the optional Termux:Boot
# addon is installed; it defers to the same idempotent bringup so both paths are identical.
sleep 8
bash "$HOME/phone-tools/evogent-boot.sh"
