package com.bbot.poc;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.netty.channel.Channel;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiDisconnected;
import net.minecraft.client.gui.inventory.GuiContainer;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.client.gui.GuiMultiplayer;
import net.minecraft.client.multiplayer.GuiConnecting;
import net.minecraft.client.network.NetworkPlayerInfo;
import net.minecraft.client.settings.KeyBinding;
import net.minecraft.block.Block;
import net.minecraft.entity.player.InventoryPlayer;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;
import net.minecraft.entity.Entity;
import net.minecraft.entity.SharedMonsterAttributes;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.passive.EntityChicken;
import net.minecraft.init.Blocks;
import net.minecraft.network.NetworkManager;
import net.minecraft.network.play.server.S08PacketPlayerPosLook;
import net.minecraft.network.play.server.S22PacketMultiBlockChange;
import net.minecraft.network.play.server.S23PacketBlockChange;
import net.minecraft.util.BlockPos;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.EnumFacing;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.Session;
import net.minecraft.util.Vec3;
import net.minecraft.world.chunk.Chunk;
import net.minecraft.world.chunk.storage.ExtendedBlockStorage;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.entity.EntityJoinWorldEvent;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;
import net.minecraftforge.fml.common.network.FMLNetworkEvent;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(
    modid = BBotHeadlessPoc.MODID,
    name = BBotHeadlessPoc.NAME,
    version = BBotHeadlessPoc.VERSION,
    acceptedMinecraftVersions = "[1.8.9]",
    acceptableRemoteVersions = "*",
    clientSideOnly = true
)
public final class BBotHeadlessPoc {
    public static final String MODID = "bbotheadlesspoc";
    public static final String NAME = "BBot Headless PoC";
    public static final String VERSION = "0.1.0";

    private static final Logger LOG = LogManager.getLogger(NAME);
    private static final int DEFAULT_DESCEND_TICKS = 60;
    private static final int DEFAULT_WARMUP_TICKS = 300;
    private static final int DEFAULT_WALK_TICKS = 200;
    private static final int DEFAULT_SPRINT_TICKS = 200;
    private static final int DEFAULT_TRACE_EVERY_TICKS = 20;
    private static final int DEFAULT_BRIDGE_PORT = 3010;
    private static final int DEFAULT_BRIDGE_STATE_EVERY_TICKS = 2;

    private enum Phase {
        WAITING_FOR_WORLD,
        DESCEND,
        WAITING_FOR_GROUND,
        WARMUP,
        WALK,
        SPRINT,
        DONE
    }

    private static final Pattern CARE_PACKAGE_COUNT = Pattern.compile("^\\s*(\\d{1,3})\\s*$");

    private static final class CarePackageHologramStatus {
        final String state;
        final Integer clicksRemaining;

        CarePackageHologramStatus(String state, Integer clicksRemaining) {
            this.state = state;
            this.clicksRemaining = clicksRemaining;
        }
    }

    private final Minecraft mc = Minecraft.getMinecraft();
    private Phase phase = Phase.WAITING_FOR_WORLD;
    private int phaseTicks;
    private int totalTicks;
    private boolean hadWorld;
    private boolean bridgeControlActive;
    private boolean bridgeWasConnected;
    private Object lastWorld;
    private Object lastDisconnectScreen;
    private LocalBridgeServer bridge;
    private final Set<BlockPos> observedChests = new HashSet<BlockPos>();
    private String carePackageRequestId;
    private BlockPos carePackageTarget;
    private int carePackageInteractionTicks;
    private String carePackageLastStatus;
    private int carePackageLastBucket = Integer.MIN_VALUE;
    private int carePackageLootTicks;
    private int carePackageLootEmptyTicks;
    private boolean carePackageLootSawContents;
    private boolean carePackageOpenedReported;
    private boolean carePackageClickPressed;
    private int carePackageClicksSent;
    private int carePackageLastTelemetryRemaining = Integer.MIN_VALUE;
    private boolean carePackageLastTelemetryLosBlocked;
    private boolean carePackageTelemetryReported;

    private boolean havePreviousPosition;
    private double previousX;
    private double previousY;
    private double previousZ;

    private final int descendTicks = envInt("BBOT_POC_DESCEND_TICKS", DEFAULT_DESCEND_TICKS);
    private final int warmupTicks = envInt("BBOT_POC_WARMUP_TICKS", DEFAULT_WARMUP_TICKS);
    private final int walkTicks = envInt("BBOT_POC_WALK_TICKS", DEFAULT_WALK_TICKS);
    private final int sprintTicks = envInt("BBOT_POC_SPRINT_TICKS", DEFAULT_SPRINT_TICKS);
    private final int traceEveryTicks = Math.max(1, envInt("BBOT_POC_TRACE_EVERY_TICKS", DEFAULT_TRACE_EVERY_TICKS));
    private final boolean skipRender = envBool("BBOT_POC_SKIP_RENDER", true);
    private final boolean autoMovementTest = envBool("BBOT_POC_AUTOTEST", false);
    private final boolean bridgeEnabled = envBool("BBOT_POC_BRIDGE_ENABLED", true);
    private final int bridgePort = Math.max(1024, envInt("BBOT_POC_BRIDGE_PORT", DEFAULT_BRIDGE_PORT));
    private final int bridgeStateEveryTicks = Math.max(1, envInt("BBOT_POC_BRIDGE_STATE_EVERY_TICKS", DEFAULT_BRIDGE_STATE_EVERY_TICKS));

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        installConfiguredSession();
        MinecraftForge.EVENT_BUS.register(this);
        FMLCommonHandler.instance().bus().register(this);

        if (bridgeEnabled) {
            bridge = new LocalBridgeServer(bridgePort);
            bridge.start();
        }

        LOG.info(
            "[BBotPoC] ready descend={} warmup={} walk={} sprint={} traceEvery={} skipRender={} autoMovementTest={} bridgeEnabled={} bridgePort={}",
            descendTicks,
            warmupTicks,
            walkTicks,
            sprintTicks,
            traceEveryTicks,
            skipRender,
            autoMovementTest,
            bridgeEnabled,
            bridgePort
        );
    }

    private void installConfiguredSession() {
        String configured = System.getenv("BBOT_SESSION_FILE");
        if (configured == null || configured.trim().isEmpty()) {
            return;
        }

        Path file = Paths.get(configured);
        try {
            byte[] raw = Files.readAllBytes(file);
            if (raw.length == 0 || raw.length > 8192) {
                throw new IllegalStateException("Invalid session credential");
            }

            JsonObject credential = new JsonParser()
                .parse(new String(raw, StandardCharsets.UTF_8))
                .getAsJsonObject();
            JsonObject profile = credential.has("selectedProfile") && credential.get("selectedProfile").isJsonObject()
                ? credential.getAsJsonObject("selectedProfile")
                : null;
            String accessToken = credential.has("accessToken") ? credential.get("accessToken").getAsString() : "";
            String username = profile != null && profile.has("name") ? profile.get("name").getAsString() : "";
            String profileId = profile != null && profile.has("id") ? profile.get("id").getAsString() : "";

            if (!username.matches("^[A-Za-z0-9_]{1,16}$")
                || !profileId.matches("(?i)^[0-9a-f]{32}$")
                || !validAccessToken(accessToken)) {
                throw new IllegalStateException("Invalid session credential");
            }

            Field sessionField = null;
            for (Field field : Minecraft.class.getDeclaredFields()) {
                if (field.getType() == Session.class) {
                    sessionField = field;
                    break;
                }
            }
            if (sessionField == null) {
                throw new IllegalStateException("Minecraft session field unavailable");
            }

            sessionField.setAccessible(true);
            sessionField.set(mc, new Session(username, profileId.toLowerCase(), accessToken, "mojang"));
            if (mc.getSession() == null || !username.equals(mc.getSession().getUsername())) {
                throw new IllegalStateException("Minecraft session was not applied");
            }
            LOG.info("[BBotPoC] authenticated session configured for {}", username);
        } catch (Throwable t) {
            throw new IllegalStateException("Failed to configure authenticated Minecraft session", t);
        } finally {
            try {
                Files.deleteIfExists(file);
            } catch (Throwable ignored) {
                // The backend also removes this short-lived file after launch.
            }
        }
    }

    private boolean validAccessToken(String token) {
        if (token == null || token.length() < 1 || token.length() > 2048) {
            return false;
        }
        for (int i = 0; i < token.length(); i++) {
            char value = token.charAt(i);
            if (value < 0x21 || value > 0x7e) {
                return false;
            }
        }
        return true;
    }

    @SubscribeEvent
    public void onClientConnected(FMLNetworkEvent.ClientConnectedToServerEvent event) {
        installInboundPositionTrace(event.manager);
    }

    @SubscribeEvent
    public void onClientDisconnected(FMLNetworkEvent.ClientDisconnectionFromServerEvent event) {
        String reason = null;
        try {
            if (event.manager != null && event.manager.getExitMessage() != null) {
                reason = event.manager.getExitMessage().getUnformattedText();
            }
        } catch (Throwable ignored) {
            // Best-effort operator diagnostic only.
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "serverDisconnected");
        if (reason != null && !reason.trim().isEmpty()) {
            String clean = reason.replace('\r', ' ').replace('\n', ' ').trim();
            if (clean.length() > 500) clean = clean.substring(0, 500);
            message.addProperty("text", clean);
        }
        if (bridge != null) bridge.emit(message);
    }

    @SubscribeEvent
    public void onChatReceived(ClientChatReceivedEvent event) {
        if (bridge == null || event.message == null) {
            return;
        }

        String text = event.message.getUnformattedText();
        if (text == null || text.isEmpty()) {
            return;
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "message");
        message.addProperty("text", text);
        message.addProperty("channel", event.type == 2 ? "actionbar" : (event.type == 1 ? "system" : "chat"));
        bridge.emit(message);
    }

    @SubscribeEvent
    public void onEntityJoinWorld(EntityJoinWorldEvent event) {
        if (bridge == null || event.world != mc.theWorld || !(event.entity instanceof EntityChicken)) {
            return;
        }

        emitBridgePositionEvent("chickenSpawn", event.entity.posX, event.entity.posY, event.entity.posZ);
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }

        updateBridgeConnectionState();
        processBridgeCommands();
        detectDisconnectedScreen();

        if (mc.thePlayer == null || mc.theWorld == null) {
            mc.skipRenderWorld = false;
            if (hadWorld) {
                LOG.info("[BBotPoC] world left; resetting test");
                emitBridgeEvent("worldReset");
            }

            releaseMovementKeys();
            resetTest();
            hadWorld = false;
            lastWorld = null;
            return;
        }

        if (!hadWorld) {
            emitBridgeIdentity();
            emitBridgeEvent("spawn");
        } else if (lastWorld != mc.theWorld) {
            observedChests.clear();
            emitBridgeEvent("worldReset");
            emitBridgeEvent("spawn");
        }

        hadWorld = true;
        lastWorld = mc.theWorld;
        mc.skipRenderWorld = skipRender;
        totalTicks++;

        tickCarePackageInteraction();
        traceLargeClientStep();

        if (!bridgeControlActive) {
            switch (phase) {
            case WAITING_FOR_WORLD:
                transitionTo(Phase.DESCEND);
                break;
            case DESCEND:
                setMovement(false, false);
                setSneak(true);
                if (++phaseTicks >= descendTicks) {
                    setSneak(false);
                    transitionTo(Phase.WAITING_FOR_GROUND);
                }
                break;
            case WAITING_FOR_GROUND:
                setMovement(false, false);
                setSneak(false);
                if (!mc.thePlayer.capabilities.isFlying && mc.thePlayer.onGround) {
                    transitionTo(autoMovementTest ? Phase.WARMUP : Phase.DONE);
                }
                break;
            case WARMUP:
                setMovement(false, false);
                if (++phaseTicks >= warmupTicks) {
                    transitionTo(Phase.WALK);
                }
                break;
            case WALK:
                setMovement(true, false);
                if (++phaseTicks >= walkTicks) {
                    transitionTo(Phase.SPRINT);
                }
                break;
            case SPRINT:
                setMovement(true, true);
                if (++phaseTicks >= sprintTicks) {
                    transitionTo(Phase.DONE);
                }
                break;
            case DONE:
                setMovement(false, false);
                break;
            default:
                break;
            }
        }

        if (bridge != null && bridge.isClientConnected() && totalTicks % bridgeStateEveryTicks == 0) {
            emitBridgeState();
        }

        if (totalTicks % traceEveryTicks == 0) {
            logState("tick");
        }
    }

    private void updateBridgeConnectionState() {
        boolean connected = bridge != null && bridge.isClientConnected();
        if (connected && !bridgeWasConnected) {
            emitBridgeIdentity();
            if (mc.thePlayer != null && mc.theWorld != null) {
                emitBridgeEvent("spawn");
            }
        }
        if (!connected && bridgeWasConnected && bridgeControlActive) {
            releaseMovementKeys();
            LOG.info("[BBotPoC] bridge disconnected; controls released and autotest remains paused");
        }
        bridgeWasConnected = connected;
    }

    private void emitBridgeIdentity() {
        if (bridge == null || mc.getSession() == null) {
            return;
        }

        String username = mc.getSession().getUsername();
        if (username == null || username.isEmpty()) {
            return;
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "identity");
        message.addProperty("username", username);
        bridge.emit(message);
    }

    private void emitBridgeEvent(String eventName) {
        if (bridge == null) {
            return;
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", eventName);
        bridge.emit(message);
    }

    private void emitBridgePositionEvent(String eventName, double x, double y, double z) {
        if (bridge == null) {
            return;
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", eventName);
        message.addProperty("x", x);
        message.addProperty("y", y);
        message.addProperty("z", z);
        bridge.emit(message);
    }

    private void traceBlockChange(BlockPos pos, net.minecraft.block.state.IBlockState state) {
        if (state == null || bridge == null) {
            return;
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "blockUpdate");
        message.addProperty("x", pos.getX());
        message.addProperty("y", pos.getY());
        message.addProperty("z", pos.getZ());
        message.addProperty("stateId", Block.getStateId(state));
        bridge.emit(message);

        if (state.getBlock() == Blocks.chest) {
            if (observedChests.add(pos)) {
                emitBridgePositionEvent("chestAppeared", pos.getX(), pos.getY(), pos.getZ());
            }
        } else if (observedChests.remove(pos)) {
            emitBridgePositionEvent("chestDisappeared", pos.getX(), pos.getY(), pos.getZ());
        }
    }

    private void processBridgeCommands() {
        if (bridge == null) {
            return;
        }

        JsonObject command;
        int processed = 0;
        while (processed++ < 64 && (command = bridge.poll()) != null) {
            if (!command.has("type")) {
                continue;
            }

            String type = command.get("type").getAsString();
            if ("controls".equals(type)) {
                boolean forward = command.has("forward") && command.get("forward").getAsBoolean();
                boolean sprint = command.has("sprint") && command.get("sprint").getAsBoolean();
                boolean sneak = command.has("sneak") && command.get("sneak").getAsBoolean();
                boolean jump = command.has("jump") && command.get("jump").getAsBoolean();
                setMovement(forward, sprint);
                setSneak(sneak);
                setJump(jump);
                bridgeControlActive = true;
            } else if ("release".equals(type)) {
                releaseMovementKeys();
                bridgeControlActive = true;
            } else if ("look".equals(type) && mc.thePlayer != null) {
                if (command.has("yaw")) {
                    mc.thePlayer.rotationYaw = command.get("yaw").getAsFloat();
                }
                if (command.has("pitch")) {
                    float pitch = command.get("pitch").getAsFloat();
                    mc.thePlayer.rotationPitch = Math.max(-90.0F, Math.min(90.0F, pitch));
                }
            } else if ("chat".equals(type) && mc.thePlayer != null && command.has("message")) {
                String message = command.get("message").getAsString();
                if (message.length() > 100) {
                    message = message.substring(0, 100);
                }
                if (!message.isEmpty()) {
                    mc.thePlayer.sendChatMessage(message);
                }
            } else if ("connectServer".equals(type) && command.has("requestId") && command.has("host") && command.has("port")) {
                connectServer(command);
            } else if ("disconnectServer".equals(type) && command.has("requestId")) {
                disconnectServer(command);
            } else if ("getPlayerCount".equals(type) && command.has("requestId")) {
                emitPlayerCountResponse(command);
            } else if ("findSlimePads".equals(type) && command.has("requestId")) {
                emitSlimePadResponse(command);
            } else if ("getChunk".equals(type) && command.has("requestId") && command.has("chunkX") && command.has("chunkZ")) {
                emitChunkResponse(command);
            } else if ("getLoadedChunks".equals(type) && command.has("requestId")) {
                emitLoadedChunksResponse(command);
            } else if ("getVolatileBlocks".equals(type) && command.has("requestId") && command.has("chunkX") && command.has("chunkZ")) {
                emitVolatileBlocksResponse(command);
            } else if ("interactCarePackage".equals(type) && command.has("requestId") &&
                    command.has("x") && command.has("y") && command.has("z")) {
                startCarePackageInteraction(command);
            } else if ("cancelCarePackageInteraction".equals(type)) {
                cancelCarePackageInteraction();
            }
        }
    }

    private void startCarePackageInteraction(JsonObject command) {
        String requestId = command.get("requestId").getAsString();
        if (carePackageRequestId != null) {
            emitCarePackageInteractionResponse(requestId, false, "BUSY");
            return;
        }
        if (mc.thePlayer == null || mc.theWorld == null || mc.playerController == null) {
            emitCarePackageInteractionResponse(requestId, false, "WORLD_UNAVAILABLE");
            return;
        }

        BlockPos target = new BlockPos(command.get("x").getAsInt(), command.get("y").getAsInt(), command.get("z").getAsInt());
        if (mc.theWorld.getBlockState(target).getBlock() != Blocks.chest) {
            emitCarePackageInteractionResponse(requestId, false, "CHEST_UNAVAILABLE");
            return;
        }
        if (!isCarePackageTargetInReach(target)) {
            emitCarePackageInteractionResponse(requestId, false, "OUT_OF_RANGE");
            return;
        }

        carePackageRequestId = requestId;
        carePackageTarget = target;
        carePackageInteractionTicks = 0;
        carePackageLastStatus = null;
        carePackageLastBucket = Integer.MIN_VALUE;
        carePackageLootTicks = 0;
        carePackageLootEmptyTicks = 0;
        carePackageLootSawContents = false;
        carePackageOpenedReported = false;
        carePackageClickPressed = false;
        carePackageClicksSent = 0;
        carePackageLastTelemetryRemaining = Integer.MIN_VALUE;
        carePackageLastTelemetryLosBlocked = false;
        carePackageTelemetryReported = false;
        releaseMovementKeys();
        bridgeControlActive = true;
    }

    private void cancelCarePackageInteraction() {
        releaseCarePackageClick();
        carePackageRequestId = null;
        carePackageTarget = null;
        carePackageInteractionTicks = 0;
        carePackageLastStatus = null;
        carePackageLastBucket = Integer.MIN_VALUE;
        carePackageLootTicks = 0;
        carePackageLootEmptyTicks = 0;
        carePackageLootSawContents = false;
        carePackageOpenedReported = false;
        carePackageClickPressed = false;
        carePackageClicksSent = 0;
        carePackageLastTelemetryRemaining = Integer.MIN_VALUE;
        carePackageLastTelemetryLosBlocked = false;
        carePackageTelemetryReported = false;
    }

    private void releaseCarePackageClick() {
        if (!carePackageClickPressed) {
            return;
        }
        carePackageClickPressed = false;
        if (mc.playerController != null) {
            mc.playerController.resetBlockRemoving();
        }
    }

    private void tickCarePackageInteraction() {
        if (carePackageRequestId == null || carePackageTarget == null) {
            return;
        }
        if (mc.thePlayer == null || mc.theWorld == null || mc.playerController == null) {
            carePackageClickPressed = false;
            finishCarePackageInteraction(false, "WORLD_UNAVAILABLE");
            return;
        }

        // Match the vanilla 1.8.9 mouse lifecycle: clickMouse() starts the block
        // interaction on the press, while resetBlockRemoving() belongs to the
        // later release path. Never START and ABORT the same click in one tick.
        if (carePackageClickPressed) {
            releaseCarePackageClick();
            if (!(mc.currentScreen instanceof GuiContainer)) {
                return;
            }
        }

        if (mc.currentScreen instanceof GuiContainer) {
            if (!carePackageOpenedReported) {
                carePackageOpenedReported = true;
                emitCarePackageOpenedEvent();
            }
            tickCarePackagePriorityLoot();
            return;
        }
        if (mc.theWorld.getBlockState(carePackageTarget).getBlock() != Blocks.chest) {
            finishCarePackageInteraction(false, "CHEST_UNAVAILABLE");
            return;
        }
        if (!isCarePackageTargetInReach(carePackageTarget)) {
            finishCarePackageInteraction(false, "OUT_OF_RANGE");
            return;
        }
        // Press/release uses two ticks per click. 600 ticks leaves enough room
        // for 200 unlock presses plus the OPEN click without weakening reach checks.
        if (++carePackageInteractionTicks > 600) {
            finishCarePackageInteraction(false, "UNLOCK_TIMEOUT");
            return;
        }

        CarePackageHologramStatus status = readCarePackageHologram(carePackageTarget);
        reportCarePackageHologram(status);

        // Knockback can change our position/angle between ticks. Re-aim at the
        // chest center on every interaction tick before sending the click.
        faceCarePackageTarget(carePackageTarget);
        boolean losBlockedByPlayer = isCarePackageLineBlockedByPlayer(carePackageTarget);

        // Start one vanilla-style left-click press. The next client tick releases
        // it via resetBlockRemoving(), instead of emitting START+ABORT together.
        mc.thePlayer.swingItem();
        if (mc.playerController.clickBlock(carePackageTarget, EnumFacing.UP)) {
            carePackageClickPressed = true;
            carePackageClicksSent++;
        }
        reportCarePackageTelemetry(status, losBlockedByPlayer);
    }

    private boolean isCarePackageTargetInReach(BlockPos target) {
        if (mc.thePlayer == null || mc.playerController == null) {
            return false;
        }
        double dx = target.getX() + 0.5D - mc.thePlayer.posX;
        double dy = target.getY() + 0.5D - (mc.thePlayer.posY + mc.thePlayer.getEyeHeight());
        double dz = target.getZ() + 0.5D - mc.thePlayer.posZ;
        double reach = mc.playerController.getBlockReachDistance();
        // Small tolerance for the chest volume itself and tick-to-tick motion.
        double allowed = Math.max(3.0D, reach + 0.35D);
        return dx * dx + dy * dy + dz * dz <= allowed * allowed;
    }

    private boolean isCarePackageLineBlockedByPlayer(BlockPos target) {
        if (mc.thePlayer == null || mc.theWorld == null) {
            return false;
        }
        Vec3 start = new Vec3(
            mc.thePlayer.posX,
            mc.thePlayer.posY + mc.thePlayer.getEyeHeight(),
            mc.thePlayer.posZ
        );
        Vec3 end = new Vec3(
            target.getX() + 0.5D,
            target.getY() + 0.5D,
            target.getZ() + 0.5D
        );

        for (Object value : mc.theWorld.playerEntities) {
            if (!(value instanceof EntityPlayer)) {
                continue;
            }
            EntityPlayer player = (EntityPlayer)value;
            if (player == mc.thePlayer || player.isDead) {
                continue;
            }
            if (player.getEntityBoundingBox().expand(0.1D, 0.1D, 0.1D).calculateIntercept(start, end) != null) {
                return true;
            }
        }
        return false;
    }

    private void reportCarePackageTelemetry(CarePackageHologramStatus status, boolean losBlockedByPlayer) {
        if (bridge == null || carePackageTarget == null) {
            return;
        }
        int remaining = status.clicksRemaining == null ? Integer.MIN_VALUE : status.clicksRemaining;
        boolean changed = !carePackageTelemetryReported
            || remaining != carePackageLastTelemetryRemaining
            || losBlockedByPlayer != carePackageLastTelemetryLosBlocked
            || carePackageInteractionTicks % 5 == 0;
        if (!changed) {
            return;
        }

        carePackageTelemetryReported = true;
        carePackageLastTelemetryRemaining = remaining;
        carePackageLastTelemetryLosBlocked = losBlockedByPlayer;

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "carePackageTelemetry");
        message.addProperty("status", status.state);
        if (status.clicksRemaining != null) {
            message.addProperty("clicksRemaining", status.clicksRemaining);
        }
        message.addProperty("clicksSent", carePackageClicksSent);
        message.addProperty("losBlocked", losBlockedByPlayer);
        bridge.emit(message);
    }

    private void faceCarePackageTarget(BlockPos target) {
        if (mc.thePlayer == null) {
            return;
        }
        double dx = target.getX() + 0.5D - mc.thePlayer.posX;
        double dy = target.getY() + 0.5D - (mc.thePlayer.posY + mc.thePlayer.getEyeHeight());
        double dz = target.getZ() + 0.5D - mc.thePlayer.posZ;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        mc.thePlayer.rotationYaw = (float)(Math.atan2(-dx, dz) * 180.0D / Math.PI);
        mc.thePlayer.rotationPitch = (float)(-Math.atan2(dy, Math.max(0.0001D, horizontal)) * 180.0D / Math.PI);
    }

    private void tickCarePackagePriorityLoot() {
        if (mc.thePlayer == null || mc.playerController == null || mc.thePlayer.openContainer == null) {
            finishCarePackageInteraction(false, "CONTAINER_UNAVAILABLE");
            return;
        }

        Container container = mc.thePlayer.openContainer;
        InventoryPlayer playerInventory = mc.thePlayer.inventory;
        int clicked = 0;
        int visibleContainerStacks = 0;
        StringBuilder names = new StringBuilder();

        for (Object value : container.inventorySlots) {
            if (!(value instanceof Slot)) {
                continue;
            }
            Slot slot = (Slot)value;

            // Care Package loot is only in the container side. Never click the
            // player's own inventory while doing the instant priority pass.
            if (slot.inventory == playerInventory) {
                continue;
            }

            ItemStack stack = slot.getStack();
            if (stack == null || stack.getItem() == null) {
                continue;
            }
            visibleContainerStacks++;

            String itemName = cleanItemDisplayName(stack.getDisplayName());
            if (!isCarePackagePriorityItem(itemName)) {
                continue;
            }

            // mode=1 is shift-click. Send every visible priority item in this
            // same client tick; no artificial sleeps between Sword/Bow/Pants.
            mc.playerController.windowClick(
                container.windowId,
                slot.slotNumber,
                0,
                1,
                mc.thePlayer
            );
            clicked++;
            if (names.length() > 0) {
                names.append(", ");
            }
            names.append(itemName);
        }

        carePackageLootTicks++;
        if (visibleContainerStacks > 0) {
            carePackageLootSawContents = true;
        }

        if (clicked > 0) {
            carePackageLootEmptyTicks = 0;
            emitCarePackageLootEvent(clicked, names.toString());
            return;
        }

        // If the server populated the chest and all priority items are gone,
        // give it two extra client ticks for late slot updates, then resume BBot.
        if (carePackageLootSawContents) {
            carePackageLootEmptyTicks++;
            if (carePackageLootEmptyTicks >= 2) {
                mc.thePlayer.closeScreen();
                finishCarePackageInteraction(true, null);
                return;
            }
        }

        // An opened container can arrive before its slot contents. Keep scanning
        // for up to one second so a late first slot update is still insta-looted.
        if (carePackageLootTicks >= 20 && !carePackageLootSawContents) {
            mc.thePlayer.closeScreen();
            finishCarePackageInteraction(true, null);
        }
    }

    private boolean isCarePackagePriorityItem(String itemName) {
        return "Mystic Sword".equalsIgnoreCase(itemName)
            || "Mystic Bow".equalsIgnoreCase(itemName)
            || "Fresh Green Pants".equalsIgnoreCase(itemName)
            || "Fresh Red Pants".equalsIgnoreCase(itemName)
            || "Fresh Orange Pants".equalsIgnoreCase(itemName)
            || "Fresh Yellow Pants".equalsIgnoreCase(itemName)
            || "Fresh Blue Pants".equalsIgnoreCase(itemName);
    }

    private String cleanItemDisplayName(String displayName) {
        if (displayName == null) {
            return "";
        }
        String clean = EnumChatFormatting.getTextWithoutFormattingCodes(displayName);
        if (clean == null) {
            return "";
        }
        return clean.replaceAll("\\s+", " ").trim();
    }

    private void emitCarePackageOpenedEvent() {
        if (bridge == null) {
            return;
        }
        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "carePackageOpened");
        bridge.emit(message);
    }

    private void emitCarePackageLootEvent(int clicked, String items) {
        if (bridge == null) {
            return;
        }
        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "carePackageLoot");
        message.addProperty("clicked", clicked);
        message.addProperty("items", items);
        bridge.emit(message);
    }

    private CarePackageHologramStatus readCarePackageHologram(BlockPos target) {
        boolean sawOpen = false;
        boolean sawLeftClick = false;
        Integer remaining = null;

        for (Object value : mc.theWorld.loadedEntityList) {
            if (!(value instanceof Entity)) {
                continue;
            }
            Entity entity = (Entity)value;
            if (!entity.hasCustomName()) {
                continue;
            }
            double dx = Math.abs(entity.posX - (target.getX() + 0.5D));
            double dz = Math.abs(entity.posZ - (target.getZ() + 0.5D));
            if (dx > 2.5D || dz > 2.5D || entity.posY < target.getY() || entity.posY > target.getY() + 5.5D) {
                continue;
            }

            String raw = entity.getCustomNameTag();
            String clean = EnumChatFormatting.getTextWithoutFormattingCodes(raw);
            if (clean == null) {
                continue;
            }
            clean = clean.trim();
            String upper = clean.toUpperCase(Locale.ROOT);
            if (upper.contains("OPEN!")) {
                sawOpen = true;
            }
            if (upper.contains("LEFT CLICK")) {
                sawLeftClick = true;
            }

            Matcher matcher = CARE_PACKAGE_COUNT.matcher(clean);
            if (matcher.matches()) {
                int count = Integer.parseInt(matcher.group(1));
                if (count >= 0 && count <= 200) {
                    remaining = count;
                }
            }
        }

        if (sawOpen) {
            return new CarePackageHologramStatus("OPEN", 0);
        }
        if (sawLeftClick && remaining != null) {
            return new CarePackageHologramStatus("LOCKED", remaining);
        }
        return new CarePackageHologramStatus("UNKNOWN", null);
    }

    private void reportCarePackageHologram(CarePackageHologramStatus status) {
        int bucket = status.clicksRemaining == null ? Integer.MIN_VALUE : status.clicksRemaining / 25;
        boolean changed = !status.state.equals(carePackageLastStatus) || bucket != carePackageLastBucket;
        if (!changed || bridge == null || carePackageTarget == null) {
            return;
        }
        carePackageLastStatus = status.state;
        carePackageLastBucket = bucket;

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "carePackageStatus");
        message.addProperty("x", carePackageTarget.getX());
        message.addProperty("y", carePackageTarget.getY());
        message.addProperty("z", carePackageTarget.getZ());
        message.addProperty("status", status.state);
        if (status.clicksRemaining != null) {
            message.addProperty("clicksRemaining", status.clicksRemaining);
        }
        bridge.emit(message);
    }

    private void finishCarePackageInteraction(boolean ok, String error) {
        String requestId = carePackageRequestId;
        cancelCarePackageInteraction();
        if (requestId != null) {
            emitCarePackageInteractionResponse(requestId, ok, error);
        }
    }

    private void emitCarePackageInteractionResponse(String requestId, boolean ok, String error) {
        if (bridge == null) {
            return;
        }
        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", requestId);
        response.addProperty("kind", "carePackageInteraction");
        response.addProperty("ok", ok);
        if (error != null) {
            response.addProperty("error", error);
        }
        bridge.emit(response);
    }

    private void detectDisconnectedScreen() {
        Object screen = mc.currentScreen;
        if (!(screen instanceof GuiDisconnected)) {
            lastDisconnectScreen = null;
            return;
        }
        if (screen == lastDisconnectScreen) {
            return;
        }
        lastDisconnectScreen = screen;

        String reason = null;
        try {
            for (Field field : GuiDisconnected.class.getDeclaredFields()) {
                if (IChatComponent.class.isAssignableFrom(field.getType())) {
                    field.setAccessible(true);
                    Object value = field.get(screen);
                    if (value instanceof IChatComponent) {
                        reason = ((IChatComponent)value).getUnformattedText();
                        break;
                    }
                }
            }
        } catch (Throwable ignored) {
            // Best-effort diagnostic only.
        }

        JsonObject message = new JsonObject();
        message.addProperty("type", "event");
        message.addProperty("event", "serverDisconnected");
        if (reason != null && !reason.trim().isEmpty()) {
            String clean = reason.replace('\r', ' ').replace('\n', ' ').trim();
            if (clean.length() > 500) clean = clean.substring(0, 500);
            message.addProperty("text", clean);
        }
        if (bridge != null) bridge.emit(message);
    }

    private void connectServer(JsonObject command) {
        String requestId = command.get("requestId").getAsString();
        String host = command.get("host").getAsString();
        int port = command.get("port").getAsInt();

        if (!host.matches("^[A-Za-z0-9._:-]{1,253}$") || port < 1 || port > 65535) {
            emitServerControlResponse(requestId, false, "INVALID_SERVER");
            return;
        }
        if (mc.theWorld != null || mc.getNetHandler() != null) {
            emitServerControlResponse(requestId, false, "ALREADY_CONNECTED");
            return;
        }

        try {
            // This bridge command runs after Minecraft has already finished startup.
            // connectToServerAtStartup() performs the Forge startup server-list probe
            // and may block the client tick for up to 30 seconds. That races the
            // Node bridge request timeout. Use Minecraft's normal runtime connection
            // screen directly instead.
            mc.displayGuiScreen(new GuiConnecting(new GuiMainMenu(), mc, host, port));
            emitServerControlResponse(requestId, true, null);
        } catch (Throwable t) {
            LOG.warn("[BBotPoC] connectServer failed", t);
            emitServerControlResponse(requestId, false, "CONNECT_FAILED");
        }
    }

    private void disconnectServer(JsonObject command) {
        String requestId = command.get("requestId").getAsString();
        if (mc.theWorld == null) {
            emitServerControlResponse(requestId, false, "NOT_CONNECTED");
            return;
        }

        try {
            releaseMovementKeys();
            mc.theWorld.sendQuittingDisconnectingPacket();
            // Acknowledge while the bridge is still attached. loadWorld(null) can
            // synchronously fire the Minecraft disconnect event, which makes Node
            // close its transport after this response has already been delivered.
            emitServerControlResponse(requestId, true, null);
            mc.loadWorld(null);
            mc.displayGuiScreen(new GuiMultiplayer(new GuiMainMenu()));
        } catch (Throwable t) {
            LOG.warn("[BBotPoC] disconnectServer failed", t);
            emitServerControlResponse(requestId, false, "DISCONNECT_FAILED");
        }
    }

    private void emitServerControlResponse(String requestId, boolean ok, String error) {
        if (bridge == null) {
            return;
        }
        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", requestId);
        response.addProperty("kind", "serverControl");
        response.addProperty("ok", ok);
        if (error != null) {
            response.addProperty("error", error);
        }
        bridge.emit(response);
    }

    private void emitPlayerCountResponse(JsonObject command) {
        if (bridge == null) {
            return;
        }

        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", command.get("requestId").getAsString());
        response.addProperty("kind", "playerCount");

        if (mc.getNetHandler() == null) {
            response.addProperty("ok", false);
            response.addProperty("error", "WORLD_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        response.addProperty("ok", true);
        response.addProperty("playerCount", mc.getNetHandler().getPlayerInfoMap().size());
        bridge.emit(response);
    }

    private void emitSlimePadResponse(JsonObject command) {
        if (bridge == null) {
            return;
        }

        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", command.get("requestId").getAsString());
        response.addProperty("kind", "slimePads");

        if (mc.thePlayer == null || mc.theWorld == null) {
            response.addProperty("ok", false);
            response.addProperty("error", "WORLD_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        int radius = command.has("radius") ? command.get("radius").getAsInt() : 32;
        int vertical = command.has("vertical") ? command.get("vertical").getAsInt() : 6;
        int limit = command.has("limit") ? command.get("limit").getAsInt() : 96;
        radius = Math.max(1, Math.min(48, radius));
        vertical = Math.max(1, Math.min(12, vertical));
        limit = Math.max(1, Math.min(256, limit));

        int baseX = (int) Math.floor(mc.thePlayer.posX);
        int baseY = (int) Math.floor(mc.thePlayer.posY);
        int baseZ = (int) Math.floor(mc.thePlayer.posZ);
        JsonArray blocks = new JsonArray();

        outer:
        for (int y = baseY - vertical; y <= baseY + vertical; y++) {
            if (y < 0 || y > 255) {
                continue;
            }
            for (int x = baseX - radius; x <= baseX + radius; x++) {
                for (int z = baseZ - radius; z <= baseZ + radius; z++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    if (mc.theWorld.getBlockState(pos).getBlock() != Blocks.slime_block) {
                        continue;
                    }

                    JsonObject block = new JsonObject();
                    block.addProperty("x", x);
                    block.addProperty("y", y);
                    block.addProperty("z", z);
                    blocks.add(block);
                    if (blocks.size() >= limit) {
                        break outer;
                    }
                }
            }
        }

        response.addProperty("ok", true);
        response.add("blocks", blocks);
        bridge.emit(response);
    }

    private void emitLoadedChunksResponse(JsonObject command) {
        if (bridge == null) {
            return;
        }

        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", command.get("requestId").getAsString());
        response.addProperty("kind", "loadedChunks");

        if (mc.theWorld == null || mc.thePlayer == null) {
            response.addProperty("ok", false);
            response.addProperty("error", "WORLD_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        int centerX = ((int) Math.floor(mc.thePlayer.posX)) >> 4;
        int centerZ = ((int) Math.floor(mc.thePlayer.posZ)) >> 4;
        // Client render distance is normally the loaded-world bound. Probe a
        // generous radius so server/client edge chunks are included as well.
        int radius = Math.max(8, Math.min(32, mc.gameSettings.renderDistanceChunks + 4));
        JsonArray chunks = new JsonArray();

        for (int x = centerX - radius; x <= centerX + radius; x++) {
            for (int z = centerZ - radius; z <= centerZ + radius; z++) {
                if (!mc.theWorld.getChunkProvider().chunkExists(x, z)) {
                    continue;
                }
                JsonObject chunk = new JsonObject();
                chunk.addProperty("x", x);
                chunk.addProperty("z", z);
                chunks.add(chunk);
            }
        }

        response.addProperty("ok", true);
        response.add("chunks", chunks);
        bridge.emit(response);
    }

    private void emitVolatileBlocksResponse(JsonObject command) {
        if (bridge == null) {
            return;
        }

        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", command.get("requestId").getAsString());
        response.addProperty("kind", "volatileBlocks");

        if (mc.theWorld == null) {
            response.addProperty("ok", false);
            response.addProperty("error", "WORLD_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        int chunkX = command.get("chunkX").getAsInt();
        int chunkZ = command.get("chunkZ").getAsInt();
        if (!mc.theWorld.getChunkProvider().chunkExists(chunkX, chunkZ)) {
            response.addProperty("ok", false);
            response.addProperty("error", "CHUNK_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        Chunk chunk = mc.theWorld.getChunkFromChunkCoords(chunkX, chunkZ);
        ExtendedBlockStorage[] storageArray = chunk.getBlockStorageArray();
        JsonArray blocks = new JsonArray();

        for (int sectionY = 0; sectionY < storageArray.length; sectionY++) {
            ExtendedBlockStorage storage = storageArray[sectionY];
            if (storage == null || storage.isEmpty()) {
                continue;
            }

            char[] data = storage.getData();
            for (int index = 0; index < data.length; index++) {
                if (data[index] == 0) {
                    continue;
                }

                int y = index >>> 8;
                int rem = index & 255;
                int z = rem >>> 4;
                int x = rem & 15;
                int stateId = Block.getStateId(storage.get(x, y, z));
                if (!isVolatileStateId(stateId)) {
                    continue;
                }

                JsonObject block = new JsonObject();
                block.addProperty("x", chunkX * 16 + x);
                block.addProperty("y", sectionY * 16 + y);
                block.addProperty("z", chunkZ * 16 + z);
                block.addProperty("stateId", stateId);
                blocks.add(block);
            }
        }

        response.addProperty("ok", true);
        response.add("blocks", blocks);
        bridge.emit(response);
    }

    private boolean isVolatileStateId(int stateId) {
        int blockId = stateId & 0x0fff;
        int metadata = (stateId >>> 12) & 0x0f;
        return blockId == 166 || blockId == 49 || blockId == 4 || blockId == 7 || (blockId == 5 && metadata == 0);
    }

    private void emitChunkResponse(JsonObject command) {
        if (bridge == null) {
            return;
        }

        JsonObject response = new JsonObject();
        response.addProperty("type", "response");
        response.addProperty("requestId", command.get("requestId").getAsString());
        response.addProperty("kind", "chunk");

        if (mc.theWorld == null) {
            response.addProperty("ok", false);
            response.addProperty("error", "WORLD_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        int chunkX = command.get("chunkX").getAsInt();
        int chunkZ = command.get("chunkZ").getAsInt();
        response.addProperty("chunkX", chunkX);
        response.addProperty("chunkZ", chunkZ);

        if (!mc.theWorld.getChunkProvider().chunkExists(chunkX, chunkZ)) {
            response.addProperty("ok", false);
            response.addProperty("error", "CHUNK_UNAVAILABLE");
            bridge.emit(response);
            return;
        }

        Chunk chunk = mc.theWorld.getChunkFromChunkCoords(chunkX, chunkZ);
        ExtendedBlockStorage[] storageArray = chunk.getBlockStorageArray();
        JsonArray sections = new JsonArray();

        for (int sectionY = 0; sectionY < storageArray.length; sectionY++) {
            ExtendedBlockStorage storage = storageArray[sectionY];
            if (storage == null || storage.isEmpty()) {
                continue;
            }

            byte[] states = new byte[16 * 16 * 16 * 2];
            int offset = 0;
            for (int y = 0; y < 16; y++) {
                for (int z = 0; z < 16; z++) {
                    for (int x = 0; x < 16; x++) {
                        int stateId = Block.getStateId(storage.get(x, y, z));
                        states[offset++] = (byte) (stateId & 0xff);
                        states[offset++] = (byte) ((stateId >>> 8) & 0xff);
                    }
                }
            }

            JsonObject section = new JsonObject();
            section.addProperty("y", sectionY);
            section.addProperty("states", Base64.getEncoder().encodeToString(states));
            sections.add(section);
        }

        response.addProperty("ok", true);
        response.add("sections", sections);
        bridge.emit(response);
    }

    private void emitBridgeState() {
        if (bridge == null || mc.thePlayer == null) {
            return;
        }

        JsonObject state = new JsonObject();
        state.addProperty("type", "state");
        state.addProperty("tick", totalTicks);
        state.addProperty("x", mc.thePlayer.posX);
        state.addProperty("y", mc.thePlayer.posY);
        state.addProperty("z", mc.thePlayer.posZ);
        state.addProperty("yaw", mc.thePlayer.rotationYaw);
        state.addProperty("pitch", mc.thePlayer.rotationPitch);
        state.addProperty("onGround", mc.thePlayer.onGround);
        state.addProperty("sprinting", mc.thePlayer.isSprinting());
        state.addProperty("collidedH", mc.thePlayer.isCollidedHorizontally);
        state.addProperty("allowFlying", mc.thePlayer.capabilities.allowFlying);
        state.addProperty("flying", mc.thePlayer.capabilities.isFlying);
        state.addProperty("phase", phase.name());
        state.addProperty("bridgeControl", bridgeControlActive);
        if (mc.getNetHandler() != null) {
            NetworkPlayerInfo info = mc.getNetHandler().getPlayerInfo(mc.thePlayer.getUniqueID());
            if (info != null && info.getResponseTime() >= 0) {
                state.addProperty("pingMs", info.getResponseTime());
            }
        }
        bridge.emit(state);
    }

    private void installInboundPositionTrace(final NetworkManager manager) {
        try {
            final Channel channel = findChannel(manager);
            if (channel == null) {
                LOG.warn("[BBotPoC] could not find NetworkManager channel; S08 trace unavailable");
                return;
            }

            final String handlerName = "bbot_poc_s08_trace";
            if (channel.pipeline().get(handlerName) != null) {
                return;
            }

            channel.pipeline().addBefore("packet_handler", handlerName, new ChannelDuplexHandler() {
                @Override
                public void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception {
                    if (msg instanceof S23PacketBlockChange) {
                        S23PacketBlockChange packet = (S23PacketBlockChange) msg;
                        traceBlockChange(packet.getBlockPosition(), packet.getBlockState());
                    } else if (msg instanceof S22PacketMultiBlockChange) {
                        S22PacketMultiBlockChange packet = (S22PacketMultiBlockChange) msg;
                        for (S22PacketMultiBlockChange.BlockUpdateData update : packet.getChangedBlocks()) {
                            traceBlockChange(update.getPos(), update.getBlockState());
                        }
                    }

                    if (msg instanceof S08PacketPlayerPosLook) {
                        S08PacketPlayerPosLook packet = (S08PacketPlayerPosLook) msg;
                        double playerX = mc.thePlayer == null ? Double.NaN : mc.thePlayer.posX;
                        double playerY = mc.thePlayer == null ? Double.NaN : mc.thePlayer.posY;
                        double playerZ = mc.thePlayer == null ? Double.NaN : mc.thePlayer.posZ;

                        LOG.warn(
                            "[BBotPoC] server-pos-look raw={},{},{} yaw={} pitch={} flags={} clientBefore={},{},{}",
                            round3(packet.getX()),
                            round3(packet.getY()),
                            round3(packet.getZ()),
                            round3(packet.getYaw()),
                            round3(packet.getPitch()),
                            packet.func_179834_f(),
                            round3(playerX),
                            round3(playerY),
                            round3(playerZ)
                        );
                    }

                    super.channelRead(ctx, msg);
                }
            });

            LOG.info("[BBotPoC] installed passive S08 position trace");
        } catch (Throwable t) {
            LOG.warn("[BBotPoC] failed to install passive S08 position trace", t);
        }
    }

    private static Channel findChannel(NetworkManager manager) throws IllegalAccessException {
        for (Field field : NetworkManager.class.getDeclaredFields()) {
            if (!Channel.class.isAssignableFrom(field.getType())) {
                continue;
            }

            field.setAccessible(true);
            Object value = field.get(manager);
            if (value instanceof Channel) {
                return (Channel) value;
            }
        }

        return null;
    }

    private void transitionTo(Phase next) {
        phase = next;
        phaseTicks = 0;

        if (next == Phase.DONE) {
            releaseMovementKeys();
        }

        LOG.info("[BBotPoC] phase={}", next);
        logState("phase");
    }

    private void setMovement(boolean forward, boolean sprint) {
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindForward.getKeyCode(), forward);
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindSprint.getKeyCode(), sprint);
    }

    private void setSneak(boolean sneak) {
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindSneak.getKeyCode(), sneak);
    }

    private void setJump(boolean jump) {
        KeyBinding.setKeyBindState(mc.gameSettings.keyBindJump.getKeyCode(), jump);
    }

    private void releaseMovementKeys() {
        if (mc.gameSettings == null) {
            return;
        }

        setMovement(false, false);
        setSneak(false);
        setJump(false);
    }

    private void resetTest() {
        phase = Phase.WAITING_FOR_WORLD;
        phaseTicks = 0;
        totalTicks = 0;
        havePreviousPosition = false;
        bridgeControlActive = false;
        observedChests.clear();
        cancelCarePackageInteraction();
    }

    private void traceLargeClientStep() {
        double x = mc.thePlayer.posX;
        double y = mc.thePlayer.posY;
        double z = mc.thePlayer.posZ;

        if (havePreviousPosition) {
            double dx = x - previousX;
            double dy = y - previousY;
            double dz = z - previousZ;
            double horizontal = Math.sqrt(dx * dx + dz * dz);

            if (horizontal > 2.0D || Math.abs(dy) > 1.0D) {
                LOG.warn(
                    "[BBotPoC] large-client-step phase={} dh={} dy={} from={},{},{} to={},{},{}",
                    phase,
                    round3(horizontal),
                    round3(dy),
                    round3(previousX),
                    round3(previousY),
                    round3(previousZ),
                    round3(x),
                    round3(y),
                    round3(z)
                );
            }
        }

        previousX = x;
        previousY = y;
        previousZ = z;
        havePreviousPosition = true;
    }

    private void logState(String reason) {
        if (mc.thePlayer == null) {
            return;
        }

        double movementSpeed = mc.thePlayer
            .getEntityAttribute(SharedMonsterAttributes.movementSpeed)
            .getAttributeValue();

        LOG.info(
            "[BBotPoC] {} phase={} tick={} pos={},{},{} vel={},{},{} yaw={} ground={} sprint={} collidedH={} allowFly={} flying={} moveAttr={}",
            reason,
            phase,
            totalTicks,
            round3(mc.thePlayer.posX),
            round3(mc.thePlayer.posY),
            round3(mc.thePlayer.posZ),
            round3(mc.thePlayer.motionX),
            round3(mc.thePlayer.motionY),
            round3(mc.thePlayer.motionZ),
            round3(mc.thePlayer.rotationYaw),
            mc.thePlayer.onGround,
            mc.thePlayer.isSprinting(),
            mc.thePlayer.isCollidedHorizontally,
            mc.thePlayer.capabilities.allowFlying,
            mc.thePlayer.capabilities.isFlying,
            round3(movementSpeed)
        );
    }

    private static int envInt(String key, int fallback) {
        String value = System.getenv(key);
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }

        try {
            return Math.max(0, Integer.parseInt(value.trim()));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static boolean envBool(String key, boolean fallback) {
        String value = System.getenv(key);
        if (value == null || value.trim().isEmpty()) {
            return fallback;
        }

        String normalized = value.trim().toLowerCase();
        if ("true".equals(normalized) || "1".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized)) {
            return true;
        }
        if ("false".equals(normalized) || "0".equals(normalized) || "no".equals(normalized) || "off".equals(normalized)) {
            return false;
        }
        return fallback;
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0D) / 1000.0D;
    }
}
