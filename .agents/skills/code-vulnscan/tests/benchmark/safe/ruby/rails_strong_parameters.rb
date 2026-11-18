# BENCHMARK: safe - explicit strong-parameter allowlist

user.update(params.require(:user).permit(:display_name, :timezone))
