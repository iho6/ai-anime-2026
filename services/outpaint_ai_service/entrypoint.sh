#!/bin/bash
set -e

comfy_args=()
serverless_args=()

comfy_enabled=false

parsing_stage="serverless"
i=1
while [ $i -le $# ]; do
    arg="${!i}"
    case "$arg" in
        "--enable-outpaint")
            comfy_enabled=true
            parsing_stage="comfy"
            ;;
        "--serverless")
            parsing_stage="serverless"
            ;;
        *)
            case "$parsing_stage" in
                "comfy")
                    comfy_args+=("$arg")
                    ;;
                "serverless")
                    serverless_args+=("$arg")
                    ;;
            esac
            ;;
    esac
    i=$((i + 1))
done

if $comfy_enabled; then
    has_port=false
    for arg in "${comfy_args[@]}"; do
        if [[ "$arg" == "--port" ]]; then
            has_port=true
            break
        fi
    done
    if [[ "$has_port" == false ]]; then
        comfy_args+=("--port" "8188")
    fi

    echo "Starting ComfyUI for outpaint: --disable-metadata ${comfy_args[*]}"
    python3 main.py --disable-metadata "${comfy_args[@]}" &

    serverless_args+=("--enable-default")
    for arg in "${comfy_args[@]}"; do
        if [[ "$arg" == "--port" ]]; then
            serverless_args+=("--default-port")
        elif [[ "$arg" =~ ^[0-9]+$ && "${serverless_args[-1]}" == "--default-port" ]]; then
            serverless_args+=("$arg")
        fi
    done
fi

echo "Starting serverless with: ${serverless_args[*]}"
exec python3 -m services.outpaint_ai_service.serverless "${serverless_args[@]}"
