package com.bbot.caretest;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import net.minecraft.server.v1_8_R3.PacketPlayInArmAnimation;
import net.minecraft.server.v1_8_R3.PacketPlayInBlockDig;
import net.minecraft.server.v1_8_R3.PacketPlayInBlockPlace;
import net.minecraft.server.v1_8_R3.PacketPlayInCloseWindow;
import net.minecraft.server.v1_8_R3.PacketPlayInFlying;
import net.minecraft.server.v1_8_R3.PacketPlayInWindowClick;
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
import org.bukkit.craftbukkit.v1_8_R3.entity.CraftPlayer;
import org.bukkit.entity.ArmorStand;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
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
    private static final int PACKET_TRACE_LIMIT = 1200;
    private static final String PACKET_HANDLER_NAME = "bbot_care_trace";

    private World pitWorld;
    private Location chestLocation;
    private ArmorStand topHologram;
    private ArmorStand bottomHologram;
    private Inventory lootInventory;
    private volatile boolean active;
    private boolean unlocked;
    private int remaining;
    private int acceptedClicks;
    private int lootDelayTicks;
    private int lootGeneration;
    private int autoKnockbackAt = -1;
    private double autoKnockbackStrength = 1.35D;
    private boolean autoKnockbackFired;
    private volatile boolean packetTelemetryEnabled = true;
    private volatile long packetTraceStartedNanos = System.nanoTime();
    private final Map<UUID, PacketTrace> packetTraces = new ConcurrentHashMap<UUID, PacketTrace>();
    private final Map<UUID, Integer> acceptedClicksByPlayer = new ConcurrentHashMap<UUID, Integer>();

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
        for (Player player : Bukkit.getOnlinePlayers()) injectPacketTap(player);
        getLogger().info("BBot Care Package test arena ready. Packet telemetry enabled.");
        getLogger().info("Use /play pit, then /caretest start. Inspect with /caretest status and /caretest packets.");
    }

    @Override
    public void onDisable() {
        for (Player player : Bukkit.getOnlinePlayers()) uninjectPacketTap(player);
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
        if ("locraw".equals(name)) {
            if (!(sender instanceof Player)) {
                sender.sendMessage("{\"server\":\"caretest\",\"gametype\":\"PIT\",\"mode\":\"PIT\",\"map\":\"The Pit\"}");
                return true;
            }
            Player player = (Player)sender;
            if (player.getWorld().equals(pitWorld)) {
                player.sendMessage("{\"server\":\"caretest\",\"gametype\":\"PIT\",\"mode\":\"PIT\",\"map\":\"The Pit\"}");
            } else {
                player.sendMessage("{\"server\":\"caretest-lobby\",\"gametype\":\"PROTOTYPE\",\"mode\":\"LOBBY\",\"map\":\"Lobby\"}");
            }
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
                + " autoKbAt=" + autoKnockbackAt
                + " packetTelemetry=" + packetTelemetryEnabled);
            List<UUID> reported = new ArrayList<UUID>();
            for (Map.Entry<UUID, PacketTrace> entry : packetTraces.entrySet()) {
                sender.sendMessage(packetSummary(entry.getKey(), entry.getValue().playerName));
                reported.add(entry.getKey());
            }
            for (Player player : pitWorld.getPlayers()) {
                if (!reported.contains(player.getUniqueId())) {
                    sender.sendMessage(packetSummary(player.getUniqueId(), player.getName()));
                }
            }
            return true;
        }
        if ("packets".equals(sub)) {
            handlePacketsCommand(sender, args);
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
            + ChatColor.GRAY + " - show accepted clicks and packet counters");
        sender.sendMessage(ChatColor.AQUA + "/caretest packets [player] [limit]"
            + ChatColor.GRAY + " - dump recent inbound Care Package packets");
        sender.sendMessage(ChatColor.AQUA + "/caretest packets clear"
            + ChatColor.GRAY + " - clear packet traces");
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
        acceptedClicksByPlayer.clear();
        clearPacketTraces();
        packetTraceStartedNanos = System.nanoTime();
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
                UUID playerId = event.getPlayer().getUniqueId();
                Integer acceptedForPlayer = acceptedClicksByPlayer.get(playerId);
                acceptedClicksByPlayer.put(playerId, acceptedForPlayer == null ? 1 : acceptedForPlayer + 1);
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
    public void onJoin(final PlayerJoinEvent event) {
        Bukkit.getScheduler().runTaskLater(this, new Runnable() {
            @Override public void run() {
                if (event.getPlayer().isOnline()) injectPacketTap(event.getPlayer());
            }
        }, 1L);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        uninjectPacketTap(event.getPlayer());
    }

    private void injectPacketTap(final Player player) {
        final Channel channel;
        try {
            channel = ((CraftPlayer)player).getHandle().playerConnection.networkManager.channel;
        } catch (Throwable error) {
            getLogger().warning("Packet telemetry injection failed for " + player.getName() + ": " + error.getClass().getSimpleName());
            return;
        }
        final UUID playerId = player.getUniqueId();
        final String playerName = player.getName();
        channel.eventLoop().execute(new Runnable() {
            @Override public void run() {
                try {
                    if (!channel.isOpen()) return;
                    if (channel.pipeline().get(PACKET_HANDLER_NAME) != null) {
                        channel.pipeline().remove(PACKET_HANDLER_NAME);
                    }
                    ChannelDuplexHandler handler = new ChannelDuplexHandler() {
                        @Override
                        public void channelRead(ChannelHandlerContext context, Object message) throws Exception {
                            recordInboundPacket(playerId, playerName, message);
                            super.channelRead(context, message);
                        }
                    };
                    if (channel.pipeline().get("packet_handler") != null) {
                        channel.pipeline().addBefore("packet_handler", PACKET_HANDLER_NAME, handler);
                    } else if (channel.pipeline().get("decoder") != null) {
                        channel.pipeline().addAfter("decoder", PACKET_HANDLER_NAME, handler);
                    } else {
                        channel.pipeline().addLast(PACKET_HANDLER_NAME, handler);
                    }
                } catch (Throwable error) {
                    getLogger().warning("Packet telemetry pipeline setup failed for " + playerName
                        + ": " + error.getClass().getSimpleName());
                }
            }
        });
    }

    private void uninjectPacketTap(Player player) {
        final Channel channel;
        try {
            channel = ((CraftPlayer)player).getHandle().playerConnection.networkManager.channel;
        } catch (Throwable ignored) {
            return;
        }
        channel.eventLoop().execute(new Runnable() {
            @Override public void run() {
                try {
                    if (channel.pipeline().get(PACKET_HANDLER_NAME) != null) {
                        channel.pipeline().remove(PACKET_HANDLER_NAME);
                    }
                } catch (Throwable ignored) {}
            }
        });
    }

    private void recordInboundPacket(UUID playerId, String playerName, Object message) {
        if (!packetTelemetryEnabled || !active) return;

        String type = null;
        String detail = "";
        if (message instanceof PacketPlayInArmAnimation) {
            type = "ARM_ANIMATION";
        } else if (message instanceof PacketPlayInBlockDig) {
            PacketPlayInBlockDig packet = (PacketPlayInBlockDig)message;
            type = "BLOCK_DIG";
            detail = String.valueOf(packet.c()) + " @ "
                + packet.a().getX() + "," + packet.a().getY() + "," + packet.a().getZ()
                + " face=" + packet.b();
        } else if (message instanceof PacketPlayInBlockPlace) {
            type = "BLOCK_PLACE";
        } else if (message instanceof PacketPlayInWindowClick) {
            type = "WINDOW_CLICK";
        } else if (message instanceof PacketPlayInCloseWindow) {
            type = "CLOSE_WINDOW";
        } else if (message instanceof PacketPlayInFlying) {
            type = "FLYING";
            detail = message.getClass().getSimpleName();
        }
        if (type == null) return;

        PacketTrace trace = packetTraces.get(playerId);
        if (trace == null) {
            PacketTrace created = new PacketTrace(playerName);
            PacketTrace previous = packetTraces.putIfAbsent(playerId, created);
            trace = previous == null ? created : previous;
        }
        long elapsedMs = Math.max(0L, (System.nanoTime() - packetTraceStartedNanos) / 1000000L);
        trace.record(elapsedMs, type, detail);
    }

    private String packetSummary(UUID playerId, String playerName) {
        PacketTrace trace = packetTraces.get(playerId);
        int accepted = acceptedClicksByPlayer.containsKey(playerId)
            ? acceptedClicksByPlayer.get(playerId) : 0;
        if (trace == null) {
            return ChatColor.GRAY + "Packets " + playerName + ": accepted=" + accepted + " no packets recorded";
        }
        return ChatColor.GRAY + "Packets " + playerName
            + ": accepted=" + accepted
            + " arm=" + trace.armAnimations()
            + " dig=" + trace.blockDigs()
            + " flying=" + trace.flying()
            + " place=" + trace.blockPlaces()
            + " windowClick=" + trace.windowClicks()
            + " closeWindow=" + trace.closeWindows();
    }

    private UUID tracedPlayerId(String playerName) {
        for (Map.Entry<UUID, PacketTrace> entry : packetTraces.entrySet()) {
            if (entry.getValue().playerName.equalsIgnoreCase(playerName)) return entry.getKey();
        }
        return null;
    }

    private void handlePacketsCommand(CommandSender sender, String[] args) {
        if (args.length >= 2 && "clear".equalsIgnoreCase(args[1])) {
            clearPacketTraces();
            packetTraceStartedNanos = System.nanoTime();
            sender.sendMessage(ChatColor.GREEN + "Care Package packet traces cleared.");
            return;
        }

        Player target = null;
        UUID targetId = null;
        String targetName = null;
        int limit = 40;
        if (args.length >= 2) {
            target = Bukkit.getPlayerExact(args[1]);
            if (target != null) {
                targetId = target.getUniqueId();
                targetName = target.getName();
            } else if (args[1].matches("\\d+")) {
                limit = parseInt(args[1], 40);
            } else {
                targetId = tracedPlayerId(args[1]);
                if (targetId != null) targetName = packetTraces.get(targetId).playerName;
            }
        }
        if (args.length >= 3) limit = parseInt(args[2], 40);
        limit = Math.max(1, Math.min(200, limit));

        if (targetId == null && sender instanceof Player) {
            target = (Player)sender;
            targetId = target.getUniqueId();
            targetName = target.getName();
        }
        if (targetId == null && packetTraces.size() == 1) {
            Map.Entry<UUID, PacketTrace> only = packetTraces.entrySet().iterator().next();
            targetId = only.getKey();
            targetName = only.getValue().playerName;
        }
        if (targetId == null && pitWorld.getPlayers().size() == 1) {
            target = pitWorld.getPlayers().get(0);
            targetId = target.getUniqueId();
            targetName = target.getName();
        }
        if (targetId == null || targetName == null) {
            sender.sendMessage(ChatColor.RED + "Usage: /caretest packets [player] [limit]");
            return;
        }

        PacketTrace trace = packetTraces.get(targetId);
        sender.sendMessage(packetSummary(targetId, targetName));
        if (trace == null) return;
        List<TraceEntry> entries = trace.latest(limit);
        if (entries.isEmpty()) {
            sender.sendMessage(ChatColor.GRAY + "No Care Package packets recorded.");
            return;
        }
        for (TraceEntry entry : entries) {
            sender.sendMessage(ChatColor.DARK_GRAY + "#" + entry.sequence
                + " +" + entry.elapsedMs + "ms "
                + ChatColor.WHITE + entry.type
                + (entry.detail.length() == 0 ? "" : ChatColor.GRAY + " " + entry.detail));
        }
    }

    private void clearPacketTraces() {
        packetTraces.clear();
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

    private static final class TraceEntry {
        final long sequence;
        final long elapsedMs;
        final String type;
        final String detail;

        TraceEntry(long sequence, long elapsedMs, String type, String detail) {
            this.sequence = sequence;
            this.elapsedMs = elapsedMs;
            this.type = type;
            this.detail = detail;
        }
    }

    private static final class PacketTrace {
        final String playerName;
        final Deque<TraceEntry> entries = new ArrayDeque<TraceEntry>();
        long sequence;
        int armAnimations;
        int blockDigs;
        int flyingPackets;
        int blockPlaces;
        int windowClicks;
        int closeWindows;

        PacketTrace(String playerName) {
            this.playerName = playerName;
        }

        synchronized void record(long elapsedMs, String type, String detail) {
            sequence++;
            if ("ARM_ANIMATION".equals(type)) armAnimations++;
            else if ("BLOCK_DIG".equals(type)) blockDigs++;
            else if ("FLYING".equals(type)) flyingPackets++;
            else if ("BLOCK_PLACE".equals(type)) blockPlaces++;
            else if ("WINDOW_CLICK".equals(type)) windowClicks++;
            else if ("CLOSE_WINDOW".equals(type)) closeWindows++;

            entries.addLast(new TraceEntry(sequence, elapsedMs, type, detail));
            while (entries.size() > PACKET_TRACE_LIMIT) entries.removeFirst();
        }

        synchronized int armAnimations() { return armAnimations; }
        synchronized int blockDigs() { return blockDigs; }
        synchronized int flying() { return flyingPackets; }
        synchronized int blockPlaces() { return blockPlaces; }
        synchronized int windowClicks() { return windowClicks; }
        synchronized int closeWindows() { return closeWindows; }

        synchronized List<TraceEntry> latest(int limit) {
            List<TraceEntry> all = new ArrayList<TraceEntry>(entries);
            int from = Math.max(0, all.size() - limit);
            return new ArrayList<TraceEntry>(all.subList(from, all.size()));
        }
    }

    private int parseInt(String value, int fallback) {
        try { return Integer.parseInt(value); } catch (NumberFormatException ignored) { return fallback; }
    }

    private double parseDouble(String value, double fallback) {
        try { return Double.parseDouble(value); } catch (NumberFormatException ignored) { return fallback; }
    }
}
