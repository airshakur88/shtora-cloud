# BENCHMARK: vulnerable - Rails SQL injection

User.where("email = '#{params[:email]}'")
