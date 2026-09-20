package com.bbot.poc;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

final class LocalBridgeServer {
    private static final Logger LOG = LogManager.getLogger(BBotHeadlessPoc.NAME);

    private final int port;
    private final ConcurrentLinkedQueue<JsonObject> inbound = new ConcurrentLinkedQueue<JsonObject>();
    private volatile PrintWriter writer;
    private volatile Socket clientSocket;
    private volatile boolean running;

    LocalBridgeServer(int port) {
        this.port = port;
    }

    void start() {
        if (running) {
            return;
        }

        running = true;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                runServer();
            }
        }, "BBotPoC-Bridge");
        thread.setDaemon(true);
        thread.start();
    }

    JsonObject poll() {
        return inbound.poll();
    }

    boolean isClientConnected() {
        Socket socket = clientSocket;
        return socket != null && socket.isConnected() && !socket.isClosed();
    }

    void emit(JsonObject object) {
        PrintWriter current = writer;
        if (current == null) {
            return;
        }

        synchronized (this) {
            current = writer;
            if (current == null) {
                return;
            }
            current.println(object.toString());
            if (current.checkError()) {
                closeClient();
            }
        }
    }

    private void runServer() {
        ServerSocket server = null;
        try {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 1);
            LOG.info("[BBotPoC] bridge listening on 127.0.0.1:{}", port);

            while (running) {
                Socket socket = server.accept();
                socket.setTcpNoDelay(true);
                handleClient(socket);
            }
        } catch (IOException e) {
            if (running) {
                LOG.warn("[BBotPoC] bridge server stopped unexpectedly", e);
            }
        } finally {
            if (server != null) {
                try {
                    server.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void handleClient(Socket socket) {
        closeClient();
        clientSocket = socket;

        try {
            writer = new PrintWriter(new BufferedWriter(new OutputStreamWriter(
                socket.getOutputStream(),
                StandardCharsets.UTF_8
            )), true);

            JsonObject hello = new JsonObject();
            hello.addProperty("type", "bridge");
            hello.addProperty("event", "connected");
            hello.addProperty("protocol", 1);
            emit(hello);

            LOG.info("[BBotPoC] bridge client connected");

            BufferedReader reader = new BufferedReader(new InputStreamReader(
                socket.getInputStream(),
                StandardCharsets.UTF_8
            ));

            String line;
            JsonParser parser = new JsonParser();
            while (running && (line = reader.readLine()) != null) {
                if (line.length() > 8192) {
                    LOG.warn("[BBotPoC] bridge ignored oversized command");
                    continue;
                }

                try {
                    JsonObject command = parser.parse(line).getAsJsonObject();
                    inbound.offer(command);
                } catch (RuntimeException ex) {
                    LOG.warn("[BBotPoC] bridge ignored invalid JSON command");
                }
            }
        } catch (IOException e) {
            if (running) {
                LOG.info("[BBotPoC] bridge client disconnected: {}", e.getMessage());
            }
        } finally {
            closeClient();
        }
    }

    private synchronized void closeClient() {
        writer = null;
        Socket socket = clientSocket;
        clientSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }
}
