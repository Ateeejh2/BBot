package com.bbot.caretest;

import java.util.ArrayList;
import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Color;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.WorldType;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.block.Action;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.LeatherArmorMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.Vector;

public final class BBotCareTestPlugin extends JavaPlugin implements Listener {
    private static final String PIT_WORLD = "caretest_pit";
    private static final int CHEST_X = 8;
    private static final int CHEST_Y = 65;
    private static final int CHEST_Z = 0;

    private World pitWorld;
    private Location chestLocation;
    private ArmorStand topHologram;
    private ArmorStand bottomHologram;
    private Inventory lootInventory;
    private boolean active;
    private boolean unlocked;
    private int remaining;
    private int acceptedClicks;
    private int lootDelayTicks;
    private int lootGeneration;
    private int autoKnockbackAt = -1;
    private double autoKnockbackStrength = 1.35D;
    private boolean autoKnockbackFired;

    @Override
    public void onEnable() {
        Bukkit.getPluginManager().registerEvents(this, this);
        pitWorld = Bukkit.createWorld(new WorldCreator(PIT_WORLD)
            .type(WorldType.FLAT)
            .generateStructures(false));
        if (pitWorld == null) {
            throw new IllegalStateException("Could not create " + PIT_WORLD);
        }
        pitWorld.setGameRuleValue("doMobSpawning", "false");
        pitWorld.setGameRuleValue("doDaylightCycle", "false");
        pitWorld.setTime(6000L);
        prepareArena();
        getLogger().info("BBot Care Package test arena ready. Use /play pit, then /caretest start.");
    }

    @Override
    public void onDisable() {
        stopEvent(false);
    }

    private void prepareArena() {
        for (int x = -20; x <= 20; x++) {
            for (int z = -20; z <= 20; z++) {
                pitWorld.getBlockAt(x, 64, z).setType(Material.STONE);
                for (int y = 65; y <= 70; y++) {
                    pitWorld.getBlockAt(x, y, z).setType(Material.AIR);
                }
            }
        }
        pitWorld.setSpawnLocation(0, 65, 0);
        chestLocation = new Location(pitWorld, CHEST_X, CHEST_Y, CHEST_Z);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String name = command.getName().toLowerCase();
        if ("play".equals(name)) {
            if (!(sender instanceof Player) || args.length != 1 || !"pit".equalsIgnoreCase(args[0])) {
                sender.sendMessage(ChatColor.RED + "Usage: /play pit");
                return true;
            }
            final Player player = (Player)sender;
            player.sendMessage("SERVER FOUND! Sending to caretest!");
            Bukkit.getScheduler().runTaskLater(this, new Runnable() {
                @Override public void run() {
                    player.teleport(new Location(pitWorld, 0.5D, 65.0D, 0.5D, -90.0F, 0.0F));
                    player.setGameMode(GameMode.SURVIVAL);
                }
            }, 2L);
            return true;
        }
        if ("l".equals(name) || "lobby".equals(name)) {
            if (sender instanceof Player) {
                Player player = (Player)sender;
                player.teleport(Bukkit.getWorlds().get(0).getSpawnLocation());
                player.sendMessage(ChatColor.GRAY + "Returned to local test lobby.");
            }
            return true;
        }
        if (!"caretest".equals(name)) return false;

        if (args.length == 0) {
            help(sender);
            return true;
        }
        String sub = args[0].toLowerCase();
        if ("start".equals(sub)) {
            int clicks = args.length >= 2 ? parseInt(args[1], 200) : 200;
            clicks = Math.max(1, Math.min(200, clicks));
            startEvent(clicks);
            sender.sendMessage(ChatColor.GREEN + "Care Package test started with " + clicks + " clicks.");
            return true;
        }
        if ("stop".equals(sub) || "reset".equals(sub)) {
            stopEvent(true);
            sender.sendMessage(ChatColor.YELLOW + "Care Package test stopped.");
            return true;
        }
        if ("status".equals(sub)) {
            sender.sendMessage(ChatColor.AQUA + "CareTest active=" + active
                + " unlocked=" + unlocked
                + " remaining=" + remaining
                + " acceptedClicks=" + acceptedClicks
                + " lootDelayTicks=" + lootDelayTicks
                + " autoKbAt=" + autoKnockbackAt);
            return true;
        }
        if ("vanish".equals(sub)) {
            vanishChest();
            sender.sendMessage(ChatColor.YELLOW + "Care Package chest removed.");
            return true;
        }
        if ("lootdelay".equals(sub)) {
            if (args.length < 2) {
                sender.sendMessage(ChatColor.RED + "Usage: /caretest lootdelay <ticks>");
                return true;
            }
            lootDelayTicks = Math.max(0, Math.min(200, parseInt(args[1], 0)));
            sender.sendMessage(ChatColor.GREEN + "Loot delay set to " + lootDelayTicks + " ticks.");
            return true;
        }
        if ("knockback".equals(sub)) {
            double strength = args.length >= 2 ? parseDouble(args[1], 1.35D) : 1.35D;
            knockbackNearby(Math.max(0.2D, Math.min(3.0D, strength)));
            sender.sendMessage(ChatColor.YELLOW + "Applied Care Package knockback.");
            return true;
        }
        if ("autokb".equals(sub)) {
            if (args.length < 2) {
                sender.sendMessage(ChatColor.RED + "Usage: /caretest autokb <remaining|off> [strength]");
                return true;
            }
            if ("off".equalsIgnoreCase(args[1])) {
                autoKnockbackAt = -1;
                autoKnockbackFired = false;
                sender.sendMessage(ChatColor.GREEN + "Automatic knockback disabled.");
                return true;
            }
            autoKnockbackAt = Math.max(0, Math.min(199, parseInt(args[1], 100)));
            autoKnockbackStrength = args.length >= 3
                ? Math.max(0.2D, Math.min(3.0D, parseDouble(args[2], 1.35D)))
                : 1.35D;
            autoKnockbackFired = false;
            sender.sendMessage(ChatColor.GREEN + "Automatic knockback at remaining <= " + autoKnockbackAt
                + " strength=" + autoKnockbackStrength);
            return true;
        }

        help(sender);
        return true;
    }

    private void help(CommandSender sender) {
        sender.sendMessage(ChatColor.AQUA + "/caretest start [clicks]"
            + ChatColor.GRAY + " - announce and spawn a Care Package");
        sender.sendMessage(ChatColor.AQUA + "/caretest status"
            + ChatColor.GRAY + " - show accepted server clicks");
        sender.sendMessage(ChatColor.AQUA + "/caretest knockback [strength]"
            + ChatColor.GRAY + " - knock nearby players away");
        sender.sendMessage(ChatColor.AQUA + "/caretest autokb <remaining|off> [strength]"
            + ChatColor.GRAY + " - reproducible knockback");
        sender.sendMessage(ChatColor.AQUA + "/caretest lootdelay <ticks>"
            + ChatColor.GRAY + " - delay GUI slot population");
        sender.sendMessage(ChatColor.AQUA + "/caretest vanish"
            + ChatColor.GRAY + " - remove the chest mid-run");
        sender.sendMessage(ChatColor.AQUA + "/caretest stop"
            + ChatColor.GRAY + " - reset the test");
    }

    private void startEvent(final int clicks) {
        stopEvent(false);
        active = true;
        unlocked = false;
        remaining = clicks;
        acceptedClicks = 0;
        autoKnockbackFired = false;
        lootGeneration++;
        for (Player player : pitWorld.getPlayers()) {
            player.sendMessage("MINOR EVENT! CARE PACKAGE in Test Area");
        }
        Bukkit.getScheduler().runTaskLater(this, new Runnable() {
            @Override public void run() {
                if (!active) return;
                Block block = chestLocation.getBlock();
                block.setType(Material.CHEST);
                createHologram();
                updateHologram();
                Bukkit.broadcastMessage(ChatColor.GRAY + "[CareTest] Chest spawned at "
                    + CHEST_X + ", " + CHEST_Y + ", " + CHEST_Z + " with " + clicks + " clicks.");
            }
        }, 20L);
    }

    private void stopEvent(boolean removeChest) {
        active = false;
        unlocked = false;
        remaining = 0;
        acceptedClicks = 0;
        lootGeneration++;
        lootInventory = null;
        removeHologram();
        if (removeChest && chestLocation != null) {
            chestLocation.getBlock().setType(Material.AIR);
        }
    }

    private void vanishChest() {
        active = false;
        removeHologram();
        if (chestLocation != null) chestLocation.getBlock().setType(Material.AIR);
        lootGeneration++;
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent event) {
        if (!active || event.getAction() != Action.LEFT_CLICK_BLOCK || event.getClickedBlock() == null) return;
        if (!isCareChest(event.getClickedBlock())) return;
        event.setCancelled(true);

        if (!unlocked) {
            if (remaining > 0) {
                remaining--;
                acceptedClicks++;
                if (autoKnockbackAt >= 0 && !autoKnockbackFired && remaining <= autoKnockbackAt) {
                    autoKnockbackFired = true;
                    final double strength = autoKnockbackStrength;
                    Bukkit.getScheduler().runTask(this, new Runnable() {
                        @Override public void run() { knockbackNearby(strength); }
                    });
                }
            }
            if (remaining <= 0) unlocked = true;
            updateHologram();
            return;
        }

        openLoot(event.getPlayer());
    }

    @EventHandler
    public void onBreak(BlockBreakEvent event) {
        if (active && isCareChest(event.getBlock())) event.setCancelled(true);
    }

    private boolean isCareChest(Block block) {
        return chestLocation != null
            && block.getWorld().equals(chestLocation.getWorld())
            && block.getX() == chestLocation.getBlockX()
            && block.getY() == chestLocation.getBlockY()
            && block.getZ() == chestLocation.getBlockZ();
    }

    private void createHologram() {
        removeHologram();
        topHologram = spawnLabel(chestLocation.clone().add(0.5D, 2.35D, 0.5D));
        bottomHologram = spawnLabel(chestLocation.clone().add(0.5D, 2.00D, 0.5D));
    }

    private ArmorStand spawnLabel(Location location) {
        ArmorStand stand = location.getWorld().spawn(location, ArmorStand.class);
        stand.setVisible(false);
        stand.setGravity(false);
        stand.setSmall(true);
        stand.setCustomNameVisible(true);
        return stand;
    }

    private void updateHologram() {
        if (topHologram == null || bottomHologram == null) return;
        if (unlocked) {
            topHologram.setCustomName(ChatColor.GREEN + "OPEN!");
            bottomHologram.setCustomName(ChatColor.RED + "LEFT CLICK");
        } else {
            topHologram.setCustomName(ChatColor.GREEN + String.valueOf(remaining));
            bottomHologram.setCustomName(ChatColor.RED + "LEFT CLICKS");
        }
    }

    private void removeHologram() {
        if (topHologram != null) topHologram.remove();
        if (bottomHologram != null) bottomHologram.remove();
        topHologram = null;
        bottomHologram = null;
    }

    private void openLoot(final Player player) {
        if (lootInventory == null) {
            lootInventory = Bukkit.createInventory(null, 27, "Care Package");
            final Inventory inventory = lootInventory;
            final int generation = ++lootGeneration;
            if (lootDelayTicks == 0) {
                populateLoot(inventory);
            } else {
                Bukkit.getScheduler().runTaskLater(this, new Runnable() {
                    @Override public void run() {
                        if (generation == lootGeneration && inventory == lootInventory) populateLoot(inventory);
                    }
                }, lootDelayTicks);
            }
        }
        player.openInventory(lootInventory);
    }

    private void populateLoot(Inventory inventory) {
        if (inventory == null) return;
        inventory.clear();
        inventory.setItem(10, named(new ItemStack(Material.GOLD_SWORD), "Mystic Sword"));
        inventory.setItem(11, named(new ItemStack(Material.BOW), "Mystic Bow"));
        inventory.setItem(12, pants("Fresh Green Pants", Color.GREEN));
        inventory.setItem(13, pants("Fresh Red Pants", Color.RED));
        inventory.setItem(14, pants("Fresh Orange Pants", Color.ORANGE));
        inventory.setItem(15, pants("Fresh Yellow Pants", Color.YELLOW));
        inventory.setItem(16, pants("Fresh Blue Pants", Color.BLUE));
    }

    private ItemStack pants(String name, Color color) {
        ItemStack stack = new ItemStack(Material.LEATHER_LEGGINGS);
        LeatherArmorMeta meta = (LeatherArmorMeta)stack.getItemMeta();
        meta.setDisplayName(name);
        meta.setColor(color);
        stack.setItemMeta(meta);
        return stack;
    }

    private ItemStack named(ItemStack stack, String name) {
        ItemMeta meta = stack.getItemMeta();
        meta.setDisplayName(name);
        stack.setItemMeta(meta);
        return stack;
    }

    private void knockbackNearby(double strength) {
        if (chestLocation == null) return;
        for (Player player : pitWorld.getPlayers()) {
            if (player.getLocation().distanceSquared(chestLocation) > 144.0D) continue;
            Vector direction = player.getLocation().toVector().subtract(chestLocation.toVector());
            direction.setY(0.0D);
            if (direction.lengthSquared() < 0.01D) direction = new Vector(1.0D, 0.0D, 0.0D);
            direction.normalize().multiply(strength).setY(0.35D);
            player.setVelocity(direction);
        }
    }

    private int parseInt(String value, int fallback) {
        try { return Integer.parseInt(value); } catch (NumberFormatException ignored) { return fallback; }
    }

    private double parseDouble(String value, double fallback) {
        try { return Double.parseDouble(value); } catch (NumberFormatException ignored) { return fallback; }
    }
}
