// BENCHMARK: vulnerable - cmdi
import javax.servlet.http.*;
import java.io.*;

public class PingServlet extends HttpServlet {
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        String host = request.getParameter("host");
        Runtime runtime = Runtime.getRuntime();
        Process proc = runtime.exec("ping -c 1 " + host);
        response.getWriter().println("started");
    }
}
