import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// Records each measured connection and how it ended, instead of reporting it.
class _Recorder extends ProductMeasurement {
  _Recorder() : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});

  final ended = <String>[];

  @override
  void Function(ProductOutcome) begin(ProductFlow flow) =>
      (outcome) => ended.add('${flow.name}:${outcome.name}');
}

/// A daemon that answers every request with nothing: connecting loads the machine's data.
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'remote',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {};
}

/// A remote machine that is not linked is redialled every five seconds by the
/// link retry, and its daemon refuses each dial at once (4404 NO_PEER_LINK).
/// Measured per tick, that read as ~720 failed connections an hour per unlinked
/// machine: prod's first day showed 1,197 of 1,233 remote connects "failed",
/// almost all under a second. One refusal is one failed connection.
void main() {
  late AppNotifier app;
  late _Recorder usage;
  const mid = 'remote';

  setUp(() {
    usage = _Recorder();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      productMeasurement: usage,
      connectionForTest: (_) => _Daemon(),
    );
    const machine = Machine(
      machineId: mid,
      name: 'Box',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates[mid] = MachineState(machine)..nodeOnline = true;
    // Connections are measured only for a signed-in account.
    app
      ..status = AppStatus.authenticated
      ..currentUser = const CurrentUserProfile(id: 'u1', email: 'u1@example.test');
  });

  tearDown(() => app.dispose());

  test('a machine refused for want of a link counts one failure, not one per retry', () {
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    // WsConn reports the refusal before the close (WsConn._onDone).
    app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
    app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    expect(usage.ended, ['remoteConnect:failed']);

    // Three link-retry ticks: closeMachine, then a dial refused again.
    for (var tick = 0; tick < 3; tick++) {
      app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
      app.connectionStatusForTest(mid, ConnectionStatus.connecting);
      app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
      app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    }
    expect(usage.ended, ['remoteConnect:failed']);

    // Linked: the next dial is measured again, and succeeds.
    app.stateOf(mid)!.needsLink = false;
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.connected);
    expect(usage.ended, ['remoteConnect:failed', 'remoteConnect:ok']);
  });

  test('an ordinary offline machine still counts each dial that ends', () {
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
    app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
    app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.connected);
    expect(usage.ended, ['remoteConnect:failed', 'remoteConnect:ok']);
  });
}
