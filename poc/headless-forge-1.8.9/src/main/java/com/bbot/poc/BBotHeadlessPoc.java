package com.bbot.poc;

import com.google.gson.JsonObject;
import io.netty.channel.Channel;
import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import java.lang.reflect.Field;
import net.minecraft.client.Minecraft;
import net.minecraft.client.settings.KeyBinding;
import net.minecraft.entity.SharedMonsterAttributes;
import net.minecraft.network.NetworkManager;
import net.minecraft.network.play.server.S08PacketPlayerPosLook;
import net.minecraftforge.client.event.ClientChatReceivedEvent;
import net.minecraftforge.common.MinecraftForge;
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

    private final Minecraft mc = Minecraft.getMinecraft();
    private Phase phase = Phase.WAITING_FOR_WORLD;
    private int phaseTicks;
    private int totalTicks;
    private boolean hadWorld;
    private boolean bridgeControlActive;
    private boolean bridgeWasConnected;
    private Object lastWorld;
    private LocalBridgeServer bridge;

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
    private final boolean bridgeEnabled = envBool("BBOT_POC_BRIDGE_ENABLED", true);
    private final int bridgePort = Math.max(1024, envInt("BBOT_POC_BRIDGE_PORT", DEFAULT_BRIDGE_PORT));
    private final int bridgeStateEveryTicks = Math.max(1, envInt("BBOT_POC_BRIDGE_STATE_EVERY_TICKS", DEFAULT_BRIDGE_STATE_EVERY_TICKS));

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        MinecraftForge.EVENT_BUS.register(this);
        FMLCommonHandler.instance().bus().register(this);

        if (bridgeEnabled) {
            bridge = new LocalBridgeServer(bridgePort);
            bridge.start();
        }

        LOG.info(
            "[BBotPoC] ready descend={} warmup={} walk={} sprint={} traceEvery={} skipRender={} bridgeEnabled={} bridgePort={}",
            descendTicks,
            warmupTicks,
            walkTicks,
            sprintTicks,
            traceEveryTicks,
            skipRender,
            bridgeEnabled,
            bridgePort
        );
    }

    @SubscribeEvent
    public void onClientConnected(FMLNetworkEvent.ClientConnectedToServerEvent event) {
        installInboundPositionTrace(event.manager);
    }

    @SubscribeEvent
    public void onClientDisconnected(FMLNetworkEvent.ClientDisconnectionFromServerEvent event) {
        emitBridgeEvent("end");
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
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END) {
            return;
        }

        updateBridgeConnectionState();

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
            emitBridgeEvent("worldReset");
            emitBridgeEvent("spawn");
        }

        hadWorld = true;
        lastWorld = mc.theWorld;
        mc.skipRenderWorld = skipRender;
        totalTicks++;

        processBridgeCommands();
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
                    transitionTo(Phase.WARMUP);
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
            }
        }
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
