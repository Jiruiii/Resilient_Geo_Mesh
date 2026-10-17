import 'rescue_web.dart';

Future<Object?> webRescueCall(String operation, List<Object?> arguments) =>
    Future<Object?>.error(const WebRescueError('rescue_web_unavailable'));
