#!/bin/bash
set -e

multi_angle_server_args=()
serverless_args=()

multi_angle_enabled=false

parsing_stage="serverless"
i=1
while [ $i -le $# ]; do
    arg="${!i}"
    case "$arg" in
        "--enable-multi-angle")
            multi_angle_enabled=true
            parsing_stage="multi_angle"
            ;;
        "--serverless")
            parsing_stage="serverless"
            ;;
        *)
            case "$parsing_stage" in
                "multi_angle")
                    multi_angle_server_args+=("$arg")
                    ;;
                "serverless")
                    serverless_args+=("$arg")
                    ;;
            esac
            ;;
    esac
    i=$((i + 1))
done

if $multi_angle_enabled; then
    has_port=false
    for arg in "${multi_angle_server_args[@]}"; do
        if [[ "$arg" == "--port" ]]; then
            has_port=true
            break
        fi
    done
    if [[ "$has_port" == false ]]; then
        multi_angle_server_args+=("--port" "8188")
    fi

    echo "Starting ComfyUI for multi-angle with: --disable-metadata ${multi_angle_server_args[*]}"
    python3 main.py --disable-metadata "${multi_angle_server_args[@]}" &

    serverless_args+=("--enable-default")
    for arg in "${multi_angle_server_args[@]}"; do
        if [[ "$arg" == "--port" ]]; then
            serverless_args+=("--default-port")
        elif [[ "$arg" =~ ^[0-9]+$ && "${serverless_args[-1]}" == "--default-port" ]]; then
            serverless_args+=("$arg")
        fi
    done
fi

echo "Starting serverless with: ${serverless_args[*]}"
exec python3 -m services.multi_angle_ai_service.serverless "${serverless_args[@]}"
